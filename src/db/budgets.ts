import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
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
