import type { CurrencyCode } from './currencies.js';
import type { LocalDate } from './time.js';

// The cumulative daily allowance of ADR-0017. All amounts are integer minor units in the
// budget's currency; the only rounding is the floor in allowanceThrough.

// What may be spent from day 1 through day `day` of an `days`-day period with limit `limitMinor`:
// floor(L * d / N). Exactly L on the last day, and never above L * d / N before it.
export function allowanceThrough(limitMinor: number, days: number, day: number): number {
  if (!Number.isSafeInteger(limitMinor) || limitMinor <= 0) {
    throw new RangeError('limitMinor must be a positive safe integer');
  }
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(day) || day < 1) {
    throw new RangeError('days and day must be positive integers');
  }
  if (day > days) throw new RangeError('day is past the end of the period');
  if (!Number.isSafeInteger(limitMinor * days)) {
    throw new RangeError('limitMinor * days exceeds the safe integer range');
  }
  return Math.floor((limitMinor * day) / days);
}

// Whether allowanceThrough stays exact for this limit over any period (31 days at most).
export function isSafeLimit(limitMinor: number): boolean {
  return (
    Number.isSafeInteger(limitMinor) && limitMinor > 0 && Number.isSafeInteger(limitMinor * 31)
  );
}

export interface Remainders {
  // Negative when today's cumulative allowance is overspent.
  readonly todayLeftMinor: number;
  // Negative when the whole limit is overspent.
  readonly periodLeftMinor: number;
}

// Leftover and overspend carry forward: today's figure is the allowance through today minus
// everything counted from the period's first day through today.
export function remainders(input: {
  readonly limitMinor: number;
  readonly days: number;
  readonly day: number;
  readonly spentThroughTodayMinor: number;
  readonly spentInPeriodMinor: number;
}): Remainders {
  return {
    todayLeftMinor:
      allowanceThrough(input.limitMinor, input.days, input.day) - input.spentThroughTodayMinor,
    periodLeftMinor: input.limitMinor - input.spentInPeriodMinor,
  };
}

export interface SpendSplit {
  // The sum of the expenses in the budget's currency.
  readonly countedMinor: number;
  // Sums per other currency: listed, never converted (ADR-0003).
  readonly notCounted: ReadonlyMap<CurrencyCode, number>;
}

export function splitByCurrency(
  expenses: readonly { readonly amountMinor: number; readonly currency: CurrencyCode }[],
  currency: CurrencyCode,
): SpendSplit {
  let countedMinor = 0;
  const notCounted = new Map<CurrencyCode, number>();
  for (const expense of expenses) {
    if (expense.currency === currency) countedMinor += expense.amountMinor;
    else
      notCounted.set(
        expense.currency,
        (notCounted.get(expense.currency) ?? 0) + expense.amountMinor,
      );
  }
  return { countedMinor, notCounted };
}

// The 1-based day of `date` in a period starting on `from`: `from` itself is day 1.
export function dayOfPeriod(from: LocalDate, date: LocalDate): number {
  return Math.round((utcDay(date) - utcDay(from)) / DAY_MS) + 1;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: LocalDate): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}
