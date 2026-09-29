import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { openDatabase, type Db } from './connection.js';
import {
  insertExpenseOrGetExisting,
  listLedgerExpensesOn,
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
