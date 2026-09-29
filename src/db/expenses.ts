import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { LocalDate } from '../domain/time.js';
import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';
import type { UserId } from './users.js';

export type ExpenseId = string & { readonly __brand: 'ExpenseId' };

export interface Expense {
  readonly id: ExpenseId;
  readonly ledgerId: LedgerId;
  readonly createdBy: UserId;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly description: string;
  readonly occurredAt: Date;
  readonly occurredOn: LocalDate;
  readonly sourceKey: string;
  readonly deletedAt: Date | null;
}

export type NewExpense = Omit<Expense, 'deletedAt'> & { readonly createdAt: Date };

interface ExpenseRow {
  id: string;
  ledger_id: string;
  created_by: string;
  amount_minor: number;
  currency: string;
  description: string;
  occurred_at: string;
  occurred_on: string;
  source_key: string;
  deleted_at: string | null;
}

const COLUMNS = `e.id, e.ledger_id, e.created_by, e.amount_minor, e.currency, e.description,
  e.occurred_at, e.occurred_on, e.source_key, e.deleted_at`;

// Inserts unless an expense with the same source_key exists; either way returns the stored row.
// This is what makes a redelivered Telegram update record nothing new.
export function insertExpenseOrGetExisting(
  db: Db,
  expense: NewExpense,
): { expense: Expense; created: boolean } {
  const { changes } = db
    .prepare<[string, string, string, number, string, string, string, string, string, string]>(
      `INSERT INTO expenses (id, ledger_id, created_by, amount_minor, currency, description,
                             occurred_at, occurred_on, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
    )
    .run(
      expense.id,
      expense.ledgerId,
      expense.createdBy,
      expense.amountMinor,
      expense.currency,
      expense.description,
      expense.occurredAt.toISOString(),
      expense.occurredOn,
      expense.sourceKey,
      expense.createdAt.toISOString(),
    );
  const stored = findExpenseBySourceKey(db, expense.sourceKey);
  if (stored === undefined) throw new Error('expense vanished after insert');
  return { expense: stored, created: changes === 1 };
}

export function findExpenseBySourceKey(db: Db, sourceKey: string): Expense | undefined {
  const row = db
    .prepare<[string], ExpenseRow>(`SELECT ${COLUMNS} FROM expenses e WHERE e.source_key = ?`)
    .get(sourceKey);
  return row === undefined ? undefined : toExpense(row);
}

export function findExpenseById(db: Db, id: ExpenseId): Expense | undefined {
  const row = db
    .prepare<[string], ExpenseRow>(`SELECT ${COLUMNS} FROM expenses e WHERE e.id = ?`)
    .get(id);
  return row === undefined ? undefined : toExpense(row);
}

// Returns false when the expense was already deleted, leaving deleted_at unchanged.
export function softDeleteExpense(db: Db, id: ExpenseId, deletedAt: Date): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      'UPDATE expenses SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(deletedAt.toISOString(), id);
  return changes === 1;
}

// Non-deleted expenses of one ledger on one local date, visible only to members of that
// ledger. Rows only: totals are computed in the domain (ADR-0002).
export function listLedgerExpensesOn(
  db: Db,
  query: { ledgerId: LedgerId; memberId: UserId; occurredOn: LocalDate },
): Expense[] {
  return db
    .prepare<[string, string, string], ExpenseRow>(
      `SELECT ${COLUMNS}
         FROM expenses e
         JOIN ledger_members m ON m.ledger_id = e.ledger_id AND m.user_id = ?
        WHERE e.ledger_id = ? AND e.occurred_on = ? AND e.deleted_at IS NULL
        ORDER BY e.occurred_at, e.id`,
    )
    .all(query.memberId, query.ledgerId, query.occurredOn)
    .map(toExpense);
}

function toExpense(row: ExpenseRow): Expense {
  const currency = toCurrencyCode(row.currency);
  if (currency === undefined) throw new Error(`expense ${row.id} has an unknown currency`);
  return {
    id: row.id as ExpenseId,
    ledgerId: row.ledger_id as LedgerId,
    createdBy: row.created_by as UserId,
    amountMinor: row.amount_minor,
    currency,
    description: row.description,
    occurredAt: new Date(row.occurred_at),
    occurredOn: row.occurred_on as LocalDate,
    sourceKey: row.source_key,
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
  };
}
