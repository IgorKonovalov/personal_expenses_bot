import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { insertCategoriesOrIgnore, type CategoryId } from './categories.js';
import { openDatabase, type Db } from './connection.js';
import {
  findExpenseById,
  findHistoryCategory,
  findTakenSourceKeys,
  insertExpenseOrGetExisting,
  insertSealedExpenseOrGetExisting,
  listLedgerExpenses,
  listLedgerExpensesBetween,
  listLedgerExpensesOn,
  rekeyContentSourceKeys,
  resealExpense,
  restoreDeletedExpense,
  setExpenseAmount,
  setExpenseCategory,
  setExpenseDate,
  setExpenseDescription,
  softDeleteExpense,
  type ExpenseId,
} from './expenses.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertRuleOrGetExisting, type RuleId } from './recurring.js';
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

describe('statement source keys', () => {
  it('finds which keys are taken, deleted rows included', () => {
    addExpense('exp-1', LEDGER_A, USER_A, 'stmt:raiffeisen-rs:aa:ledger-a');
    addExpense('exp-2', LEDGER_A, USER_A, 'stmt:raiffeisen-rs:bb:ledger-a');
    softDeleteExpense(db, 'exp-2' as ExpenseId, NOW);

    expect(
      findTakenSourceKeys(db, [
        'stmt:raiffeisen-rs:aa:ledger-a',
        'stmt:raiffeisen-rs:bb:ledger-a',
        'stmt:raiffeisen-rs:cc:ledger-a',
      ]),
    ).toEqual(new Set(['stmt:raiffeisen-rs:aa:ledger-a', 'stmt:raiffeisen-rs:bb:ledger-a']));
  });

  it('re-keys statement rows with the other content keys when a ledger is sealed', () => {
    addExpense('exp-1', LEDGER_A, USER_A, 'stmt:raiffeisen-rs:aa:ledger-a');
    addExpense('exp-2', LEDGER_A, USER_A, 'tg:1:2');
    addExpense('exp-3', LEDGER_B, USER_B, 'stmt:raiffeisen-rs:aa:ledger-b');

    expect(rekeyContentSourceKeys(db, LEDGER_A)).toBe(1);
    expect(db.prepare('SELECT id, source_key FROM expenses ORDER BY id').all()).toEqual([
      { id: 'exp-1', source_key: 'sealed:exp-1' },
      { id: 'exp-2', source_key: 'tg:1:2' },
      { id: 'exp-3', source_key: 'stmt:raiffeisen-rs:aa:ledger-b' },
    ]);
  });
});

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

  it('lists every live expense of a ledger by date, time and id, to members only', () => {
    const add = (id: string, occurredOn: string, occurredAt: string) =>
      insertExpenseOrGetExisting(db, {
        id: id as ExpenseId,
        ledgerId: LEDGER_A,
        createdBy: USER_A,
        amountMinor: 45000,
        currency: 'RSD',
        description: 'coffee',
        occurredAt: new Date(occurredAt),
        occurredOn: occurredOn as LocalDate,
        sourceKey: `tg:${id}`,
        createdAt: NOW,
      });
    add('late', '2026-09-30', '2026-09-30T18:00:00Z');
    add('b-early', '2026-09-30', '2026-09-30T08:00:00Z');
    add('a-early', '2026-09-30', '2026-09-30T08:00:00Z');
    add('old', '2024-01-01', '2024-01-01T08:00:00Z');
    add('deleted', '2025-05-05', '2025-05-05T08:00:00Z');
    softDeleteExpense(db, 'deleted' as ExpenseId, NOW);
    addExpense('elsewhere', LEDGER_B, USER_B, 'tg:9:9');

    expect(
      listLedgerExpenses(db, { ledgerId: LEDGER_A, memberId: USER_A }).map((e) => e.id),
    ).toEqual(['old', 'a-early', 'b-early', 'late']);
    expect(listLedgerExpenses(db, { ledgerId: LEDGER_A, memberId: USER_B })).toEqual([]);
  });

  it('edits amount, description and date by compare-and-set, stamping updated_at', () => {
    addExpense('exp-a', LEDGER_A, USER_A, 'tg:1:1');
    addExpense('exp-b', LEDGER_A, USER_A, 'tg:1:2');
    softDeleteExpense(db, 'exp-b' as ExpenseId, NOW);
    const id = 'exp-a' as ExpenseId;
    const at = (iso: string) => new Date(iso);
    const row = () =>
      db
        .prepare(
          `SELECT amount_minor, currency, description, description_key, occurred_at, occurred_on,
                  updated_at FROM expenses WHERE id = 'exp-a'`,
        )
        .get();

    expect(row()).toMatchObject({ updated_at: null });
    expect(setExpenseAmount(db, id, { amountMinor: 45000, currency: 'RSD' }, NOW)).toBe(false);
    expect(
      setExpenseAmount(
        db,
        id,
        { amountMinor: 120000, currency: 'RSD' },
        at('2026-09-30T10:00:00Z'),
      ),
    ).toBe(true);
    expect(
      setExpenseAmount(
        db,
        id,
        { amountMinor: 120000, currency: 'EUR' },
        at('2026-09-30T10:01:00Z'),
      ),
    ).toBe(true);
    expect(
      setExpenseDescription(
        db,
        id,
        { description: 'Капучино', descriptionKey: 'капучино' },
        at('2026-09-30T10:02:00Z'),
      ),
    ).toBe(true);
    expect(
      setExpenseDescription(db, id, { description: 'Капучино', descriptionKey: 'капучино' }, NOW),
    ).toBe(false);
    expect(setExpenseDate(db, id, '2026-09-28' as LocalDate, at('2026-09-30T10:03:00Z'))).toBe(
      true,
    );
    expect(setExpenseDate(db, id, '2026-09-28' as LocalDate, NOW)).toBe(false);

    expect(row()).toEqual({
      amount_minor: 120000,
      currency: 'EUR',
      description: 'Капучино',
      description_key: 'капучино',
      occurred_at: '2026-09-29T10:00:00.000Z',
      occurred_on: '2026-09-28',
      updated_at: '2026-09-30T10:03:00.000Z',
    });

    const deleted = 'exp-b' as ExpenseId;
    expect(setExpenseAmount(db, deleted, { amountMinor: 1, currency: 'RSD' }, NOW)).toBe(false);
    expect(setExpenseDescription(db, deleted, { description: 'x', descriptionKey: 'x' }, NOW)).toBe(
      false,
    );
    expect(setExpenseDate(db, deleted, '2026-09-01' as LocalDate, NOW)).toBe(false);
    expect(
      db.prepare("SELECT amount_minor, updated_at FROM expenses WHERE id = 'exp-b'").get(),
    ).toEqual({ amount_minor: 45000, updated_at: null });
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

  function addSealedRule() {
    insertRuleOrGetExisting(db, {
      id: 'rule-1' as RuleId,
      ledgerId: LEDGER_A,
      userId: USER_A,
      kind: 'expense',
      mode: 'auto',
      template: null,
      sealedTemplate: { currency: 'RSD', sealed: Buffer.from('template') },
      reminderText: null,
      schedule: { kind: 'monthly', day: 1 },
      nextDueOn: '2026-10-01' as LocalDate,
      sourceKey: null,
      createdAt: NOW,
    });
  }

  it("stores a sealed occurrence's rule, and a reseal clears it", () => {
    addSealedRule();
    const { expense } = insertSealedExpenseOrGetExisting(db, {
      id: 'exp-r' as ExpenseId,
      ledgerId: LEDGER_A,
      createdBy: USER_A,
      currency: 'RSD',
      occurredAt: NOW,
      occurredOn: DAY,
      sourceKey: 'rec:rule-1:2026-09-29',
      createdAt: NOW,
      sealed: Buffer.from('template'),
      sealedRuleId: 'rule-1' as RuleId,
    });
    expect(expense).toMatchObject({ sealedRuleId: 'rule-1', sealed: Buffer.from('template') });

    const resealed = resealExpense(db, 'exp-r' as ExpenseId, {
      sealed: Buffer.from('own'),
      currency: 'RSD',
      updatedAt: NOW,
    });

    expect(resealed).toBe(true);
    expect(findExpenseById(db, 'exp-r' as ExpenseId)).toMatchObject({
      sealedRuleId: null,
      sealed: Buffer.from('own'),
    });
  });

  it('refuses a rule on a plaintext row at the schema level', () => {
    addSealedRule();
    addExpense('exp-p', LEDGER_A, USER_A, 'tg:1:1');

    expect(() =>
      db.prepare("UPDATE expenses SET sealed_rule_id = 'rule-1' WHERE id = 'exp-p'").run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
