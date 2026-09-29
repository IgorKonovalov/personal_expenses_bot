import { listLedgerExpensesOn } from '../db/expenses.js';
import { findActiveLedger, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { sumByCurrency } from '../domain/aggregate.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import type { ServiceDeps } from './provisionUser.js';

export interface TodaySummary {
  readonly ledger: Ledger;
  // The user's current local date.
  readonly date: LocalDate;
  // Per currency, first-seen order; empty when nothing was recorded.
  readonly totals: ReadonlyMap<CurrencyCode, number>;
}

// Totals of the active ledger's non-deleted expenses whose occurred_on is the user's local
// today. Summed in the domain, not SQL (ADR-0002).
export function todaySummary(
  { db }: Pick<ServiceDeps, 'db'>,
  input: { readonly user: User; readonly now: Date },
): TodaySummary {
  const ledger = findActiveLedger(db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  const date = localDateOf(input.now, input.user.timezone);
  const expenses = listLedgerExpensesOn(db, {
    ledgerId: ledger.id,
    memberId: input.user.id,
    occurredOn: date,
  });
  return { ledger, date, totals: sumByCurrency(expenses) };
}
