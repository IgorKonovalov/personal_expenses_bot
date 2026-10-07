import { dayOfPeriod } from './budget.js';
import type { LocalDate } from './time.js';

// The spending pace of a period: its cumulative spend by day. Amounts are integer minor units,
// each item already converted and rounded on its own (ADR-0023), so the sums are exact.

export interface DatedAmount {
  readonly occurredOn: LocalDate;
  readonly amountMinor: number;
}

// The cumulative sum of `items` at the end of each day of a `days`-day period starting `from`,
// day 1 first, through `through`: one point per day, a day with nothing spent repeating the one
// before. Empty when `through` is before `from`; at most `days` points. An item dated outside
// the points' days is not counted.
export function cumulativeByDay(
  items: Iterable<DatedAmount>,
  from: LocalDate,
  days: number,
  through: LocalDate,
): number[] {
  const count = Math.max(0, Math.min(days, dayOfPeriod(from, through)));
  const daily = new Array<number>(count).fill(0);
  for (const item of items) {
    const index = dayOfPeriod(from, item.occurredOn) - 1;
    if (index < 0 || index >= count) continue;
    daily[index] = safeAdd(daily[index] ?? 0, item.amountMinor);
  }
  let total = 0;
  return daily.map((amountMinor) => (total = safeAdd(total, amountMinor)));
}

function safeAdd(a: number, b: number): number {
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw new RangeError('total exceeds the safe integer range');
  return total;
}
