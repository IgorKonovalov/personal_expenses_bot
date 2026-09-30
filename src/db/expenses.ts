import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { LocalDate } from '../domain/time.js';
import type { CategoryId } from './categories.js';
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
  // NULL for expenses recorded before categories existed (ADR-0007).
  readonly category: ExpenseCategory | null;
}

export interface ExpenseCategory {
  readonly id: CategoryId;
  readonly name: string;
}

export type NewExpense = Omit<Expense, 'deletedAt' | 'category'> & {
  readonly createdAt: Date;
  readonly categoryId?: CategoryId;
  // descriptionKey(description), the key the category is learned under (ADR-0008).
  readonly descriptionKey?: string;
};

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
  category_id: number | null;
  category_name: string | null;
}

const COLUMNS = `e.id, e.ledger_id, e.created_by, e.amount_minor, e.currency, e.description,
  e.occurred_at, e.occurred_on, e.source_key, e.deleted_at,
  e.category_id, c.name AS category_name`;
const FROM = 'expenses e LEFT JOIN categories c ON c.id = e.category_id';

// Inserts unless an expense with the same source_key exists; either way returns the stored row.
// This is what makes a redelivered Telegram update record nothing new.
export function insertExpenseOrGetExisting(
  db: Db,
  expense: NewExpense,
): { expense: Expense; created: boolean } {
  const { changes } = db
    .prepare<
      [
        string,
        string,
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        number | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO expenses (id, ledger_id, created_by, amount_minor, currency, description,
                             occurred_at, occurred_on, source_key, created_at, category_id,
                             description_key, category_set_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      expense.categoryId ?? null,
      expense.descriptionKey ?? null,
      expense.categoryId === undefined ? null : expense.createdAt.toISOString(),
    );
  const stored = findExpenseBySourceKey(db, expense.sourceKey);
  if (stored === undefined) throw new Error('expense vanished after insert');
  return { expense: stored, created: changes === 1 };
}

export function findExpenseBySourceKey(db: Db, sourceKey: string): Expense | undefined {
  const row = db
    .prepare<[string], ExpenseRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE e.source_key = ?`)
    .get(sourceKey);
  return row === undefined ? undefined : toExpense(row);
}

export function findExpenseById(db: Db, id: ExpenseId): Expense | undefined {
  const row = db
    .prepare<[string], ExpenseRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE e.id = ?`)
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

// Returns false when the expense was not deleted, leaving the row unchanged.
export function restoreDeletedExpense(db: Db, id: ExpenseId): boolean {
  const { changes } = db
    .prepare<[string]>(
      'UPDATE expenses SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL',
    )
    .run(id);
  return changes === 1;
}

// The category of the ledger's live expense with this description key whose category was set
// most recently, skipping expenses whose category is archived (ADR-0008 history step). A change
// from the card stamps category_set_at, so the corrected expense becomes the match.
export function findHistoryCategory(
  db: Db,
  ledgerId: LedgerId,
  descriptionKey: string,
): CategoryId | undefined {
  const id = db
    .prepare<[string, string], number>(
      `SELECT e.category_id
         FROM expenses e JOIN categories c ON c.id = e.category_id
        WHERE e.ledger_id = ? AND e.description_key = ?
          AND e.deleted_at IS NULL AND c.archived_at IS NULL
        ORDER BY COALESCE(e.category_set_at, e.created_at) DESC, e.rowid DESC
        LIMIT 1`,
    )
    .pluck()
    .get(ledgerId, descriptionKey);
  return id === undefined ? undefined : (id as CategoryId);
}

// Sets a live expense's category. Returns false when the expense is deleted or already in that
// category, leaving the row unchanged.
export function setExpenseCategory(
  db: Db,
  id: ExpenseId,
  categoryId: CategoryId,
  setAt: Date,
): boolean {
  const { changes } = db
    .prepare<[number, string, string, number]>(
      `UPDATE expenses SET category_id = ?, category_set_at = ?
        WHERE id = ? AND deleted_at IS NULL AND category_id IS NOT ?`,
    )
    .run(categoryId, setAt.toISOString(), id, categoryId);
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
         FROM ${FROM}
         JOIN ledger_members m ON m.ledger_id = e.ledger_id AND m.user_id = ?
        WHERE e.ledger_id = ? AND e.occurred_on = ? AND e.deleted_at IS NULL
        ORDER BY e.occurred_at, e.id`,
    )
    .all(query.memberId, query.ledgerId, query.occurredOn)
    .map(toExpense);
}

// Non-deleted expenses of one ledger with occurred_on in [from, to], both inclusive, visible only
// to members. Local-date strings compare in calendar order, so no timezone math runs in SQL.
export function listLedgerExpensesBetween(
  db: Db,
  query: { ledgerId: LedgerId; memberId: UserId; from: LocalDate; to: LocalDate },
): Expense[] {
  return db
    .prepare<[string, string, string, string], ExpenseRow>(
      `SELECT ${COLUMNS}
         FROM ${FROM}
         JOIN ledger_members m ON m.ledger_id = e.ledger_id AND m.user_id = ?
        WHERE e.ledger_id = ? AND e.occurred_on BETWEEN ? AND ? AND e.deleted_at IS NULL
        ORDER BY e.occurred_on, e.occurred_at, e.id`,
    )
    .all(query.memberId, query.ledgerId, query.from, query.to)
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
    category:
      row.category_id === null || row.category_name === null
        ? null
        : { id: row.category_id as CategoryId, name: row.category_name },
  };
}
