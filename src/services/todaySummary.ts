import type { Db } from '../db/connection.js';
import { listLedgerExpensesBetween, listLedgerExpensesOn, type Expense } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findActiveLedger, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { summarizeConverted } from '../domain/aggregate.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { openExpenses, type KeyDeps } from './ledgerKeys.js';
import { addDays } from '../domain/dateText.js';
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

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// Totals of the active ledger's non-deleted expenses whose occurred_on is the ledger's local
// today, in its effective timezone (ADR-0015). Converted and summed in the domain, not SQL
// (ADR-0002, ADR-0022). A locked sealed ledger (ADR-0020) reads as `locked`.
export function todaySummary(
  deps: Deps,
  input: { readonly user: User; readonly now: Date },
): TodaySummary | { readonly kind: 'locked' } {
  const { db } = deps;
  const ledger = findActiveLedger(db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  const date = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesOn(db, { ledgerId: ledger.id, memberId: input.user.id, occurredOn: date }),
  );
  if (opened.kind === 'locked') return opened;
  return { ledger, date, ...convertedTotals(db, ledger, date, opened.expenses) };
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
  // A shared ledger is never sealed: openExpenses only passes its rows through.
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesOn(deps.db, {
      ledgerId: ledger.id,
      memberId: bound.readerId,
      occurredOn: date,
    }),
  );
  if (opened.kind === 'locked') throw new Error(`group ledger ${ledger.id} is sealed`);
  const expenses = opened.expenses;
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

// How many days the /today chart shows, ending at the shown day.
export const RECENT_DAYS = 7;

export interface RecentDayTotals {
  readonly ledger: Ledger;
  // The last day, the one highlighted.
  readonly date: LocalDate;
  // RECENT_DAYS days ending at `date`, oldest first, each with its expenses converted into the
  // ledger's currency at the NBS rate of the day (ADR-0022); 0 for a day with none. A currency
  // with no rate is left out of the totals.
  readonly days: readonly { readonly date: LocalDate; readonly totalMinor: number }[];
  // True when any total holds converted foreign spending.
  readonly approximate: boolean;
}

// The active ledger's day totals for the RECENT_DAYS days ending at `date`, its local today when
// `date` is undefined. An expense counts on its stored local date (occurred_on), so one sent at
// 00:30 local counts on that day whatever the UTC date. A locked sealed ledger reads as `locked`.
export function recentDayTotals(
  deps: Deps,
  input: { readonly user: User; readonly date?: LocalDate | undefined; readonly now: Date },
): RecentDayTotals | { readonly kind: 'locked' } {
  const { db } = deps;
  const ledger = findActiveLedger(db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  const date = input.date ?? localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  const from = addDays(date, 1 - RECENT_DAYS);
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesBetween(db, { ledgerId: ledger.id, memberId: input.user.id, from, to: date }),
  );
  if (opened.kind === 'locked') return opened;
  const rateOf = rateLookupBetween(db, from, date);
  let approximate = false;
  const days = Array.from({ length: RECENT_DAYS }, (_, i) => {
    const day = addDays(from, i);
    const { converted, convertedFrom } = summarizeConverted(
      opened.expenses.filter((expense) => expense.occurredOn === day),
      ledger.defaultCurrency,
      rateOf,
    );
    if (convertedFrom.length > 0) approximate = true;
    return { date: day, totalMinor: converted?.totalMinor ?? 0 };
  });
  return { ledger, date, days, approximate };
}
