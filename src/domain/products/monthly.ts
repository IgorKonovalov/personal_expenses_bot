import type { CurrencyCode } from '../currencies.js';
import type { LocalDate } from '../time.js';
import { unitPriceMinor, type AmountMilli, type Unit } from './amount.js';

// A product's purchases folded per month and per currency (ADR-0039). A price is what was spent
// on the sized items over the amount they bought, so a bigger pack weighs more: never a mean of
// item prices. An item without a readable size counts in spend only.

export interface PricedItem {
  readonly occurredOn: LocalDate;
  readonly currency: CurrencyCode;
  readonly totalMinor: number;
  // Undefined when the item's size was unreadable.
  readonly amount: AmountMilli | undefined;
}

export interface PriceLine {
  readonly currency: CurrencyCode;
  // Every item.
  readonly spentMinor: number;
  // The items with a size, and what they bought.
  readonly sizedMinor: number;
  readonly amount: AmountMilli;
  // The items without a size.
  readonly unsized: number;
  // sizedMinor per l, kg or piece; undefined when no item had a size.
  readonly unitPriceMinor: number | undefined;
}

export interface MonthLine extends PriceLine {
  // `YYYY-MM`.
  readonly month: string;
}

interface Sum {
  spentMinor: number;
  sizedMinor: number;
  amount: AmountMilli;
  unsized: number;
}

function fold(sums: Map<string, Sum>, key: string, item: PricedItem): void {
  const sum = sums.get(key) ?? { spentMinor: 0, sizedMinor: 0, amount: 0n, unsized: 0 };
  sum.spentMinor += item.totalMinor;
  if (item.amount === undefined) sum.unsized += 1;
  else {
    sum.sizedMinor += item.totalMinor;
    sum.amount += item.amount;
  }
  sums.set(key, sum);
}

function lineOf(currency: CurrencyCode, sum: Sum, unit: Unit): PriceLine {
  return {
    currency,
    ...sum,
    unitPriceMinor:
      sum.amount === 0n ? undefined : unitPriceMinor(sum.sizedMinor, sum.amount, unit),
  };
}

// One line per month and currency, newest month first, then by currency code.
export function monthLines(items: readonly PricedItem[], unit: Unit): MonthLine[] {
  const sums = new Map<string, Sum>();
  for (const item of items) fold(sums, `${item.occurredOn.slice(0, 7)} ${item.currency}`, item);
  return [...sums]
    .map(([key, sum]) => {
      const [month = '', currency = ''] = key.split(' ');
      return { month, ...lineOf(currency as CurrencyCode, sum, unit) };
    })
    .sort((a, b) => b.month.localeCompare(a.month) || a.currency.localeCompare(b.currency));
}

// One all-time line per currency, by currency code.
export function totalLines(items: readonly PricedItem[], unit: Unit): PriceLine[] {
  const sums = new Map<string, Sum>();
  for (const item of items) fold(sums, item.currency, item);
  return [...sums]
    .map(([currency, sum]) => lineOf(currency as CurrencyCode, sum, unit))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
