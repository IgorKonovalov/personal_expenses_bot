import type { Db } from '../db/connection.js';
import { listLedgerExpensesOn, type Expense } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findActiveLedger, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { summarizeConverted } from '../domain/aggregate.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { Money } from '../domain/money.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { boundGroupLedger, peopleOf, type PersonTotals } from './periodSummary.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

export interface TodaySummary {
  readonly ledger: Ledger;
  // The ledger's current local date.
  readonly date: LocalDate;
  // The ledger default currency first, holding every expense converted into it at the NBS rate
  // of the day (ADR-0022), then each currency with no rate alphabetically; empty when nothing
  // was recorded.
  readonly totals: ReadonlyMap<CurrencyCode, number>;
  // The original totals of the foreign expenses converted into the first total.
  readonly convertedFrom: readonly Money[];
  // The currencies of the totals after the first that have no rate.
  readonly unconverted: readonly CurrencyCode[];
  // A group report's per-person section.
  readonly people?: readonly PersonTotals[];
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'>;

// Totals of the active ledger's non-deleted expenses whose occurred_on is the ledger's local
// today, in its effective timezone (ADR-0015). Converted and summed in the domain, not SQL
// (ADR-0002, ADR-0022).
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
  return { ledger, date, ...convertedTotals(db, ledger, date, expenses) };
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
  const rateOf = rateLookupBetween(deps.db, date, date);
  return {
    ledger,
    date,
    ...convertedTotals(deps.db, ledger, date, expenses),
    people: peopleOf(deps.db, ledger, expenses, rateOf),
  };
}

function convertedTotals(
  db: Db,
  ledger: Ledger,
  date: LocalDate,
  expenses: readonly Expense[],
): Pick<TodaySummary, 'totals' | 'convertedFrom' | 'unconverted'> {
  const { converted, convertedFrom, unconverted } = summarizeConverted(
    expenses,
    ledger.defaultCurrency,
    rateLookupBetween(db, date, date),
  );
  const blocks = converted === undefined ? unconverted : [converted, ...unconverted];
  return {
    totals: new Map(blocks.map((c) => [c.currency, c.totalMinor])),
    convertedFrom,
    unconverted: unconverted.map((c) => c.currency),
  };
}
