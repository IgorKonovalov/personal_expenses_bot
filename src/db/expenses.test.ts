import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { insertCategoriesOrIgnore, type CategoryId } from './categories.js';
import { openDatabase, type Db } from './connection.js';
import {
  findHistoryCategory,
  insertExpenseOrGetExisting,
  listLedgerExpensesBetween,
  listLedgerExpensesOn,
  restoreDeletedExpense,
  setExpenseCategory,
  softDeleteExpense,
  type ExpenseId,
} from './expenses.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-09-29T10:00:00Z');
const DAY = '2026-09-29' as LocalDate;
const USER_A = 'user-a' as UserId;
const USER_B = 'user-b' as UserId;
const LEDGER_A = 'ledger-a' as LedgerId;
const LEDGER_B = 'ledger-b' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  for (const [userId, ledgerId] of [
    [USER_A, LEDGER_A],
    [USER_B, LEDGER_B],
  ] as const) {
    insertUser(db, { id: userId, timezone: 'Europe/Belgrade', createdAt: NOW });
    insertLedger(db, {
      id: ledgerId,
      kind: 'personal',
      name: 'Personal',
      defaultCurrency: 'RSD',
      ownerUserId: userId,
      createdAt: NOW,
    });
    insertMember(db, { ledgerId, userId, role: 'owner' });
  }
});

function addExpense(id: string, ledgerId: LedgerId, createdBy: UserId, sourceKey: string) {
  return insertExpenseOrGetExisting(db, {
    id: id as ExpenseId,
    ledgerId,
    createdBy,
    amountMinor: 45000,
    currency: 'RSD',
    description: 'coffee',
    occurredAt: NOW,
    occurredOn: DAY,
    sourceKey,
    createdAt: NOW,
  });
}

describe('expenses repository', () => {
  it("never lists user A's personal-ledger expenses to user B", () => {
    addExpense('exp-a', LEDGER_A, USER_A, 'tg:1:1');

    expect(
      listLedgerExpensesOn(db, { ledgerId: LEDGER_A, memberId: USER_B, occurredOn: DAY }),
    ).toEqual([]);
    expect(
      listLedgerExpensesOn(db, { ledgerId: LEDGER_B, memberId: USER_B, occurredOn: DAY }),
    ).toEqual([]);
    expect(
      listLedgerExpensesOn(db, { ledgerId: LEDGER_A, memberId: USER_A, occurredOn: DAY }).map(
        (e) => e.id,
      ),
    ).toEqual(['exp-a']);
  });

  it('returns the existing row for a repeated source key', () => {
    const first = addExpense('exp-1', LEDGER_A, USER_A, 'tg:1:1');
    const second = addExpense('exp-2', LEDGER_A, USER_A, 'tg:1:1');

    expect(first.created).toBe(true);
    expect(second).toEqual({ expense: first.expense, created: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual({ n: 1 });
  });

  it('omits soft-deleted expenses from the listing', () => {
    addExpense('exp-a', LEDGER_A, USER_A, 'tg:1:1');
    expect(softDeleteExpense(db, 'exp-a' as ExpenseId, NOW)).toBe(true);
    expect(softDeleteExpense(db, 'exp-a' as ExpenseId, NOW)).toBe(false);
    expect(
      listLedgerExpensesOn(db, { ledgerId: LEDGER_A, memberId: USER_A, occurredOn: DAY }),
    ).toEqual([]);
  });

  it('restores only a deleted expense, and lists it again', () => {
    addExpense('exp-a', LEDGER_A, USER_A, 'tg:1:1');
    const deletedAt = () =>
      db.prepare("SELECT deleted_at FROM expenses WHERE id = 'exp-a'").pluck().get();

    expect(restoreDeletedExpense(db, 'exp-a' as ExpenseId)).toBe(false);
    expect(softDeleteExpense(db, 'exp-a' as ExpenseId, NOW)).toBe(true);
    expect(deletedAt()).toBe('2026-09-29T10:00:00.000Z');
    expect(restoreDeletedExpense(db, 'exp-a' as ExpenseId)).toBe(true);
    expect(deletedAt()).toBeNull();
    expect(restoreDeletedExpense(db, 'exp-a' as ExpenseId)).toBe(false);
    expect(
      listLedgerExpensesOn(db, { ledgerId: LEDGER_A, memberId: USER_A, occurredOn: DAY }).map(
        (e) => e.id,
      ),
    ).toEqual(['exp-a']);
  });

  it('finds the history category per ledger, newest live expense first', () => {
    const categoryOf = (ledgerId: LedgerId, nameKey: string) => {
      insertCategoriesOrIgnore(db, ledgerId, [{ name: nameKey, nameKey, presetKey: null }], NOW);
      return db
        .prepare('SELECT id FROM categories WHERE ledger_id = ? AND name_key = ?')
        .pluck()
        .get(ledgerId, nameKey) as CategoryId;
    };
    const cafeA = categoryOf(LEDGER_A, 'кафе');
    const groceriesA = categoryOf(LEDGER_A, 'продукты');
    const cafeB = categoryOf(LEDGER_B, 'кафе');
    const add = (id: string, ledgerId: LedgerId, createdBy: UserId, categoryId: CategoryId) =>
      insertExpenseOrGetExisting(db, {
        id: id as ExpenseId,
        ledgerId,
        createdBy,
        amountMinor: 45000,
        currency: 'RSD',
        description: 'Кофе',
        occurredAt: NOW,
        occurredOn: DAY,
        sourceKey: `tg:${id}`,
        createdAt: NOW,
        categoryId,
        descriptionKey: 'кофе',
      });

    add('a1', LEDGER_A, USER_A, cafeA);
    add('b1', LEDGER_B, USER_B, cafeB);
    expect(findHistoryCategory(db, LEDGER_A, 'кофе')).toBe(cafeA);
    expect(findHistoryCategory(db, LEDGER_B, 'кофе')).toBe(cafeB);
    expect(findHistoryCategory(db, LEDGER_A, 'чай')).toBeUndefined();

    add('a2', LEDGER_A, USER_A, groceriesA);
    expect(findHistoryCategory(db, LEDGER_A, 'кофе')).toBe(groceriesA);
    softDeleteExpense(db, 'a2' as ExpenseId, NOW);
    expect(findHistoryCategory(db, LEDGER_A, 'кофе')).toBe(cafeA);
    expect(findHistoryCategory(db, LEDGER_B, 'кофе')).toBe(cafeB);
  });

  it('sets a live expense category once and never on a deleted one', () => {
    insertCategoriesOrIgnore(db, LEDGER_A, [{ name: 'x', nameKey: 'x', presetKey: null }], NOW);
    const x = db
      .prepare("SELECT id FROM categories WHERE name_key = 'x'")
      .pluck()
      .get() as CategoryId;
    addExpense('exp-a', LEDGER_A, USER_A, 'tg:1:1');
    addExpense('exp-b', LEDGER_A, USER_A, 'tg:1:2');
    softDeleteExpense(db, 'exp-b' as ExpenseId, NOW);

    const later = new Date('2026-09-30T12:00:00.000Z');
    expect(setExpenseCategory(db, 'exp-a' as ExpenseId, x, later)).toBe(true);
    expect(setExpenseCategory(db, 'exp-a' as ExpenseId, x, NOW)).toBe(false);
    expect(setExpenseCategory(db, 'exp-b' as ExpenseId, x, NOW)).toBe(false);
    expect(
      db.prepare('SELECT id, category_id, category_set_at FROM expenses ORDER BY id').all(),
    ).toEqual([
      { id: 'exp-a', category_id: x, category_set_at: '2026-09-30T12:00:00.000Z' },
      { id: 'exp-b', category_id: null, category_set_at: null },
    ]);
  });

  it('lists live expenses of a date range, both ends inclusive, to members only', () => {
    const add = (id: string, occurredOn: string) =>
      insertExpenseOrGetExisting(db, {
        id: id as ExpenseId,
        ledgerId: LEDGER_A,
        createdBy: USER_A,
        amountMinor: 45000,
        currency: 'RSD',
        description: 'coffee',
        occurredAt: NOW,
        occurredOn: occurredOn as LocalDate,
        sourceKey: `tg:${id}`,
        createdAt: NOW,
      });
    add('before', '2026-08-31');
    add('first', '2026-09-01');
    add('last', '2026-09-30');
    add('after', '2026-10-01');
    add('deleted', '2026-09-15');
    softDeleteExpense(db, 'deleted' as ExpenseId, NOW);
    const range = { from: '2026-09-01' as LocalDate, to: '2026-09-30' as LocalDate };

    expect(
      listLedgerExpensesBetween(db, { ledgerId: LEDGER_A, memberId: USER_A, ...range }).map(
        (e) => e.id,
      ),
    ).toEqual(['first', 'last']);
    expect(
      listLedgerExpensesBetween(db, { ledgerId: LEDGER_A, memberId: USER_B, ...range }),
    ).toEqual([]);
  });

  it('rejects a non-positive amount at the schema level', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO expenses (id, ledger_id, created_by, amount_minor, currency, description,
                                 occurred_at, occurred_on, source_key, created_at)
           VALUES ('x', 'ledger-a', 'user-a', 0, 'RSD', 'd', 't', '2026-09-29', 'k', 't')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
