import { listLedgerExpensesBetween } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findLedgerForMember, type Ledger, type LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { dayOfPeriod } from '../domain/budget.js';
import { convert } from '../domain/fx.js';
import { cumulativeByDay, type DatedAmount } from '../domain/pace.js';
import { previous as previousOf, type Period } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { openExpenses } from './ledgerKeys.js';
import type { ledgerPeriodSummary } from './periodSummary.js';
import { effectiveTimezone } from './recordExpense.js';

// One period's cumulative spend by day in the ledger's currency (ADR-0022): each expense
// converted at its day's rate and rounded before the sum, as the summary screen counts it. An
// expense with no rate is left out, as it is of the summary's converted block.
export interface PaceSeries {
  readonly period: Period;
  readonly days: number;
  // One point per day through `through`, day 1 first.
  readonly points: readonly number[];
  // The last day the points run through.
  readonly through: LocalDate;
}

export interface PeriodPace {
  readonly currency: Ledger['defaultCurrency'];
  // The shown period through the ledger's today, or whole once it is past.
  readonly current: PaceSeries;
  // The period before it, whole.
  readonly previous: PaceSeries;
  // True when the ledger's today is inside the shown period.
  readonly running: boolean;
}

type Deps = Parameters<typeof ledgerPeriodSummary>[0];

// The pace of `period` and the period before it, read through the user's membership in the
// ledger's effective timezone (ADR-0015). Undefined once the user is no longer a member, for a
// period that starts after today, and while a sealed ledger is locked.
export function periodPace(
  deps: Deps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly period: Period;
    readonly now: Date;
  },
): PeriodPace | undefined {
  const ledger = findLedgerForMember(deps.db, input.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  const today = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  if (input.period.from > today) return undefined;
  const running = today <= input.period.to;
  const current = series(deps, input.user, ledger, input.period, running ? today : input.period.to);
  const before = previousOf(input.period);
  const previous = series(deps, input.user, ledger, before, before.to);
  if (current === undefined || previous === undefined) return undefined;
  return { currency: ledger.defaultCurrency, current, previous, running };
}

function series(
  deps: Deps,
  user: User,
  ledger: Ledger,
  period: Period,
  through: LocalDate,
): PaceSeries | undefined {
  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesBetween(deps.db, {
      ledgerId: ledger.id,
      memberId: user.id,
      from: period.from,
      to: period.to,
    }),
  );
  if (opened.kind === 'locked') return undefined;
  const rateOf = rateLookupBetween(deps.db, period.from, period.to);
  const items: DatedAmount[] = [];
  for (const expense of opened.expenses) {
    const converted = convert(expense, ledger.defaultCurrency, (currency) =>
      rateOf(currency, expense.occurredOn),
    );
    if (converted !== undefined) {
      items.push({ occurredOn: expense.occurredOn, amountMinor: converted.amountMinor });
    }
  }
  const days = dayOfPeriod(period.from, period.to);
  return { period, days, points: cumulativeByDay(items, period.from, days, through), through };
}
