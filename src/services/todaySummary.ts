import { listLedgerExpensesOn } from '../db/expenses.js';
import { findActiveLedger, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { sumByCurrency } from '../domain/aggregate.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { boundGroupLedger, peopleOf, type PersonTotals } from './periodSummary.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

export interface TodaySummary {
  readonly ledger: Ledger;
  // The ledger's current local date.
  readonly date: LocalDate;
  // Per currency, first-seen order; empty when nothing was recorded.
  readonly totals: ReadonlyMap<CurrencyCode, number>;
  // A group report's per-person section.
  readonly people?: readonly PersonTotals[];
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'>;

// Totals of the active ledger's non-deleted expenses whose occurred_on is the ledger's local
// today, in its effective timezone (ADR-0015). Summed in the domain, not SQL (ADR-0002).
export function todaySummary(
  deps: Deps,
  input: { readonly user: User; readonly now: Date },
): TodaySummary {
  const { db } = deps;
  const ledger = findActiveLedger(db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  const date = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  const expenses = listLedgerExpensesOn(db, {
    ledgerId: ledger.id,
    memberId: input.user.id,
    occurredOn: date,
  });
  return { ledger, date, totals: sumByCurrency(expenses) };
}

// A bound group's today in the ledger's timezone, with the per-person section. Undefined for an
// unbound chat.
export function groupTodaySummary(
  deps: Deps,
  input: { readonly chatId: number; readonly now: Date },
): TodaySummary | undefined {
  const bound = boundGroupLedger(deps, input.chatId);
  if (bound === undefined) return undefined;
  const { ledger } = bound;
  const date = bound.today(input.now);
  const expenses = listLedgerExpensesOn(deps.db, {
    ledgerId: ledger.id,
    memberId: bound.readerId,
    occurredOn: date,
  });
  return {
    ledger,
    date,
    totals: sumByCurrency(expenses),
    people: peopleOf(deps.db, ledger, expenses),
  };
}
