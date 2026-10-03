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

// A row of a sealed ledger (ADR-0020): amount, description and category live only inside
// `sealed`, which the ledger-keys service opens. The compiler sends every reader through it.
export interface SealedExpense {
  readonly id: ExpenseId;
  readonly ledgerId: LedgerId;
  readonly createdBy: UserId;
  readonly currency: CurrencyCode;
  readonly occurredAt: Date;
  readonly occurredOn: LocalDate;
  readonly sourceKey: string;
  readonly deletedAt: Date | null;
  readonly sealed: Buffer;
}

export type StoredExpense = Expense | SealedExpense;

export function isSealed(expense: StoredExpense): expense is SealedExpense {
  return 'sealed' in expense;
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

export type NewSealedExpense = Omit<SealedExpense, 'deletedAt'> & { readonly createdAt: Date };

interface ExpenseRow {
  id: string;
  ledger_id: string;
  created_by: string;
  // NULL exactly when `sealed` is set.
  amount_minor: number | null;
  currency: string;
  description: string | null;
  occurred_at: string;
  occurred_on: string;
  source_key: string;
  deleted_at: string | null;
  category_id: number | null;
  category_name: string | null;
  sealed: Buffer | null;
}

const COLUMNS = `e.id, e.ledger_id, e.created_by, e.amount_minor, e.currency, e.description,
  e.occurred_at, e.occurred_on, e.source_key, e.deleted_at,
  e.category_id, c.name AS category_name, e.sealed`;
const FROM = 'expenses e LEFT JOIN categories c ON c.id = e.category_id';

// Inserts unless an expense with the same source_key exists; either way returns the stored row.
// This is what makes a redelivered Telegram update record nothing new.
export function insertExpenseOrGetExisting(
  db: Db,
  expense: NewExpense,
): { expense: StoredExpense; created: boolean } {
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

// The sealed twin of insertExpenseOrGetExisting: the plaintext columns stay NULL.
export function insertSealedExpenseOrGetExisting(
  db: Db,
  expense: NewSealedExpense,
): { expense: StoredExpense; created: boolean } {
  const { changes } = db
    .prepare<[string, string, string, string, string, string, string, string, Buffer]>(
      `INSERT INTO expenses (id, ledger_id, created_by, currency, occurred_at, occurred_on,
                             source_key, created_at, sealed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
    )
    .run(
      expense.id,
      expense.ledgerId,
      expense.createdBy,
      expense.currency,
      expense.occurredAt.toISOString(),
      expense.occurredOn,
      expense.sourceKey,
      expense.createdAt.toISOString(),
      expense.sealed,
    );
  const stored = findExpenseBySourceKey(db, expense.sourceKey);
  if (stored === undefined) throw new Error('expense vanished after insert');
  return { expense: stored, created: changes === 1 };
}

export function findExpenseBySourceKey(db: Db, sourceKey: string): StoredExpense | undefined {
  const row = db
    .prepare<[string], ExpenseRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE e.source_key = ?`)
    .get(sourceKey);
  return row === undefined ? undefined : toStoredExpense(row);
}

export function findExpenseById(db: Db, id: ExpenseId): StoredExpense | undefined {
  const row = db
    .prepare<[string], ExpenseRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE e.id = ?`)
    .get(id);
  return row === undefined ? undefined : toStoredExpense(row);
}

// Returns false when the expense was already deleted, leaving deleted_at unchanged.
// Hard-deletes every expense of the ledger, soft-deleted ones included. Run it after the
// ledger's receipts are gone. Returns how many.
export function deleteLedgerExpenses(db: Db, ledgerId: LedgerId): number {
  return db.prepare<[string]>('DELETE FROM expenses WHERE ledger_id = ?').run(ledgerId).changes;
}

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

// The card edits: compare-and-set on a live expense, stamping updated_at. Each returns false when
// the expense is deleted or already holds the value, leaving the row unchanged.

export function setExpenseAmount(
  db: Db,
  id: ExpenseId,
  money: { readonly amountMinor: number; readonly currency: CurrencyCode },
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[number, string, string, string, number, string]>(
      `UPDATE expenses SET amount_minor = ?, currency = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND (amount_minor IS NOT ? OR currency IS NOT ?)`,
    )
    .run(
      money.amountMinor,
      money.currency,
      updatedAt.toISOString(),
      id,
      money.amountMinor,
      money.currency,
    );
  return changes === 1;
}

// The description key moves with the description, so the ADR-0008 history step learns the new
// wording; the category stays.
export function setExpenseDescription(
  db: Db,
  id: ExpenseId,
  text: { readonly description: string; readonly descriptionKey: string },
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[string, string, string, string, string]>(
      `UPDATE expenses SET description = ?, description_key = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND description IS NOT ?`,
    )
    .run(text.description, text.descriptionKey, updatedAt.toISOString(), id, text.description);
  return changes === 1;
}

// A sealed row's edit or category change (ADR-0020): the whole payload is sealed again by the
// caller, so the blob is replaced, with the currency (plaintext) and the stamp the change
// carries. Returns false when the expense is deleted.
export function resealExpense(
  db: Db,
  id: ExpenseId,
  change: {
    readonly sealed: Buffer;
    readonly currency: CurrencyCode;
    readonly updatedAt?: Date;
    readonly categorySetAt?: Date;
  },
): boolean {
  const { changes } = db
    .prepare<[Buffer, string, string | null, string | null, string]>(
      `UPDATE expenses
          SET sealed = ?, currency = ?, updated_at = COALESCE(?, updated_at),
              category_set_at = COALESCE(?, category_set_at)
        WHERE id = ? AND deleted_at IS NULL AND sealed IS NOT NULL`,
    )
    .run(
      change.sealed,
      change.currency,
      change.updatedAt?.toISOString() ?? null,
      change.categorySetAt?.toISOString() ?? null,
      id,
    );
  return changes === 1;
}

// occurred_on only: occurred_at stays the instant the user told us.
export function setExpenseDate(
  db: Db,
  id: ExpenseId,
  occurredOn: LocalDate,
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[string, string, string, string]>(
      `UPDATE expenses SET occurred_on = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND occurred_on IS NOT ?`,
    )
    .run(occurredOn, updatedAt.toISOString(), id, occurredOn);
  return changes === 1;
}

// The ledger's plaintext rows, deleted ones included: what sealing a ledger seals.
export function listLedgerPlaintextExpenses(db: Db, ledgerId: LedgerId): Expense[] {
  return db
    .prepare<[string], ExpenseRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE e.ledger_id = ? AND e.sealed IS NULL ORDER BY e.rowid`,
    )
    .all(ledgerId)
    .map(toExpense);
}

// Turns a plaintext row into a sealed one: `sealed` holds what the plaintext columns held, and
// they are cleared. Returns false when the row is already sealed.
export function sealExpenseInPlace(db: Db, id: ExpenseId, sealed: Buffer): boolean {
  const { changes } = db
    .prepare<[Buffer, string]>(
      `UPDATE expenses
          SET sealed = ?, amount_minor = NULL, description = NULL, category_id = NULL,
              description_key = NULL
        WHERE id = ? AND sealed IS NULL`,
    )
    .run(sealed, id);
  return changes === 1;
}

// Replaces every content-derived source key of the ledger (`sms:` fingerprints, `rcpt:` fiscal
// ids) with `sealed:<expenseId>`, deleted rows included; `tg:` keys stay. Returns the number of
// rows re-keyed.
export function rekeyContentSourceKeys(db: Db, ledgerId: LedgerId): number {
  return db
    .prepare<[string]>(
      `UPDATE expenses
          SET source_key = 'sealed:' || id
        WHERE ledger_id = ?
          AND (substr(source_key, 1, 4) = 'sms:' OR substr(source_key, 1, 5) = 'rcpt:')`,
    )
    .run(ledgerId).changes;
}

// Non-deleted expenses of one ledger on one local date, visible only to members of that
// ledger. Rows only: totals are computed in the domain (ADR-0002).
export function listLedgerExpensesOn(
  db: Db,
  query: { ledgerId: LedgerId; memberId: UserId; occurredOn: LocalDate },
): StoredExpense[] {
  return db
    .prepare<[string, string, string], ExpenseRow>(
      `SELECT ${COLUMNS}
         FROM ${FROM}
         JOIN ledger_members m ON m.ledger_id = e.ledger_id AND m.user_id = ?
        WHERE e.ledger_id = ? AND e.occurred_on = ? AND e.deleted_at IS NULL
        ORDER BY e.occurred_at, e.id`,
    )
    .all(query.memberId, query.ledgerId, query.occurredOn)
    .map(toStoredExpense);
}

// Non-deleted expenses of one ledger with occurred_on in [from, to], both inclusive, visible only
// to members. Local-date strings compare in calendar order, so no timezone math runs in SQL.
export function listLedgerExpensesBetween(
  db: Db,
  query: { ledgerId: LedgerId; memberId: UserId; from: LocalDate; to: LocalDate },
): StoredExpense[] {
  return db
    .prepare<[string, string, string, string], ExpenseRow>(
      `SELECT ${COLUMNS}
         FROM ${FROM}
         JOIN ledger_members m ON m.ledger_id = e.ledger_id AND m.user_id = ?
        WHERE e.ledger_id = ? AND e.occurred_on BETWEEN ? AND ? AND e.deleted_at IS NULL
        ORDER BY e.occurred_on, e.occurred_at, e.id`,
    )
    .all(query.memberId, query.ledgerId, query.from, query.to)
    .map(toStoredExpense);
}

function toStoredExpense(row: ExpenseRow): StoredExpense {
  if (row.sealed === null) return toExpense(row);
  const currency = toCurrencyCode(row.currency);
  if (currency === undefined) throw new Error(`expense ${row.id} has an unknown currency`);
  return {
    id: row.id as ExpenseId,
    ledgerId: row.ledger_id as LedgerId,
    createdBy: row.created_by as UserId,
    currency,
    occurredAt: new Date(row.occurred_at),
    occurredOn: row.occurred_on as LocalDate,
    sourceKey: row.source_key,
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
    sealed: row.sealed,
  };
}

function toExpense(row: ExpenseRow): Expense {
  const currency = toCurrencyCode(row.currency);
  if (currency === undefined) throw new Error(`expense ${row.id} has an unknown currency`);
  if (row.amount_minor === null || row.description === null) {
    throw new Error(`plaintext expense ${row.id} has no amount or description`);
  }
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
