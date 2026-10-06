import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { CategoryId } from './categories.js';
import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';

// A ledger's budget settings (ADR-0017). Every write is an absolute set and reports whether it
// changed the row, so a redelivered answer or a double tap converges on one state.

export type BudgetScope = 'all' | 'optional';

export interface LedgerBudget {
  readonly ledgerId: LedgerId;
  // Null while only category caps are set.
  readonly limitMinor: number | null;
  readonly currency: CurrencyCode;
  readonly scope: BudgetScope;
  // 1..31: the day of the month a period starts on, clamped to shorter months.
  readonly periodStartDay: number;
}

interface BudgetRow {
  ledger_id: string;
  limit_minor: number | null;
  currency: string;
  scope: BudgetScope;
  period_start_day: number;
}

export function findLedgerBudget(db: Db, ledgerId: LedgerId): LedgerBudget | undefined {
  const row = db
    .prepare<[string], BudgetRow>(
      `SELECT ledger_id, limit_minor, currency, scope, period_start_day
         FROM ledger_budgets WHERE ledger_id = ?`,
    )
    .get(ledgerId);
  if (row === undefined) return undefined;
  const currency = toCurrencyCode(row.currency);
  if (currency === undefined) throw new Error(`budget of ${row.ledger_id} has an unknown currency`);
  return {
    ledgerId: row.ledger_id as LedgerId,
    limitMinor: row.limit_minor,
    currency,
    scope: row.scope,
    periodStartDay: row.period_start_day,
  };
}

// Sets the overall limit and adopts `currency` as the budget's. Returns false when the budget
// already holds both: nothing is written.
export function setBudgetLimit(
  db: Db,
  ledgerId: LedgerId,
  limit: { readonly limitMinor: number; readonly currency: CurrencyCode },
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[string, number, string, string]>(
      `INSERT INTO ledger_budgets (ledger_id, limit_minor, currency, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (ledger_id) DO UPDATE
          SET limit_minor = excluded.limit_minor, currency = excluded.currency,
              updated_at = excluded.updated_at
        WHERE limit_minor IS NOT excluded.limit_minor OR currency IS NOT excluded.currency`,
    )
    .run(ledgerId, limit.limitMinor, limit.currency, updatedAt.toISOString());
  return changes === 1;
}

// Gives a ledger a budget with no limit, in `currency`, unless it has one: the row a category
// cap's currency is read from. Returns false when the budget existed.
export function ensureLedgerBudget(
  db: Db,
  ledgerId: LedgerId,
  currency: CurrencyCode,
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[string, string, string]>(
      `INSERT INTO ledger_budgets (ledger_id, currency, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (ledger_id) DO NOTHING`,
    )
    .run(ledgerId, currency, updatedAt.toISOString());
  return changes === 1;
}

export interface CategoryCap {
  readonly categoryId: CategoryId;
  readonly name: string;
  readonly capMinor: number;
}

// The caps of the ledger's active categories, in category order. An archived category's cap
// stays stored but is neither listed nor counted.
export function listLedgerCaps(db: Db, ledgerId: LedgerId): CategoryCap[] {
  return db
    .prepare<[string], { category_id: number; name: string; cap_minor: number }>(
      `SELECT k.category_id, c.name, k.cap_minor
         FROM category_caps k JOIN categories c ON c.id = k.category_id
        WHERE c.ledger_id = ? AND c.archived_at IS NULL
        ORDER BY c.id`,
    )
    .all(ledgerId)
    .map((row) => ({
      categoryId: row.category_id as CategoryId,
      name: row.name,
      capMinor: row.cap_minor,
    }));
}

// Sets a category's cap for the period. Returns false when it already has this cap.
export function setCategoryCap(
  db: Db,
  categoryId: CategoryId,
  capMinor: number,
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[number, number, string]>(
      `INSERT INTO category_caps (category_id, cap_minor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (category_id) DO UPDATE
          SET cap_minor = excluded.cap_minor, updated_at = excluded.updated_at
        WHERE cap_minor IS NOT excluded.cap_minor`,
    )
    .run(categoryId, capMinor, updatedAt.toISOString());
  return changes === 1;
}

// Returns false when the category had no cap.
export function clearCategoryCap(db: Db, categoryId: CategoryId): boolean {
  return (
    db.prepare<[number]>('DELETE FROM category_caps WHERE category_id = ?').run(categoryId)
      .changes === 1
  );
}

// Deletes every cap of the ledger's categories, archived ones included. Returns how many.
export function deleteLedgerCaps(db: Db, ledgerId: LedgerId): number {
  return db
    .prepare<[string]>(
      `DELETE FROM category_caps
        WHERE category_id IN (SELECT id FROM categories WHERE ledger_id = ?)`,
    )
    .run(ledgerId).changes;
}

// Deletes the ledger's budget row, if any. Its caps go with deleteLedgerCaps.
export function deleteLedgerBudget(db: Db, ledgerId: LedgerId): boolean {
  return (
    db.prepare<[string]>('DELETE FROM ledger_budgets WHERE ledger_id = ?').run(ledgerId).changes > 0
  );
}

// Sets what the limit counts. A ledger without a budget gets one with no limit, in `currency`.
// Returns false when the scope is already set: nothing is written.
export function setBudgetScope(
  db: Db,
  ledgerId: LedgerId,
  setting: { readonly scope: BudgetScope; readonly currency: CurrencyCode },
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[string, string, string, string]>(
      `INSERT INTO ledger_budgets (ledger_id, currency, scope, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (ledger_id) DO UPDATE
          SET scope = excluded.scope, updated_at = excluded.updated_at
        WHERE scope IS NOT excluded.scope`,
    )
    .run(ledgerId, setting.currency, setting.scope, updatedAt.toISOString());
  return changes === 1;
}

// Sets the period start day. A ledger without a budget gets one with no limit, in `currency`.
// Returns false when the day is already set: nothing is written.
export function setBudgetStartDay(
  db: Db,
  ledgerId: LedgerId,
  setting: { readonly startDay: number; readonly currency: CurrencyCode },
  updatedAt: Date,
): boolean {
  const { changes } = db
    .prepare<[string, string, number, string]>(
      `INSERT INTO ledger_budgets (ledger_id, currency, period_start_day, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (ledger_id) DO UPDATE
          SET period_start_day = excluded.period_start_day, updated_at = excluded.updated_at
        WHERE period_start_day IS NOT excluded.period_start_day`,
    )
    .run(ledgerId, setting.currency, setting.startDay, updatedAt.toISOString());
  return changes === 1;
}
