import type { CategoryLine } from './aggregate.js';

// A period against the one before it, in integer minor units of one currency. No floats: the
// percent is one integer division, rounded once.

// The change in whole percent, `round((cur − prev) × 100 / prev)` rounded half away from zero.
// Undefined when there is nothing to compare against (prev is 0).
export function percentChange(prevMinor: number, curMinor: number): number | undefined {
  if (!Number.isSafeInteger(prevMinor) || !Number.isSafeInteger(curMinor)) {
    throw new RangeError('amounts must be safe integers');
  }
  if (prevMinor <= 0) return undefined;
  const numerator = BigInt(curMinor - prevMinor) * 100n;
  const denominator = BigInt(prevMinor);
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  return Number(numerator < 0n ? -rounded : rounded);
}

// How an amount moved: `new` when the period before had none of it.
export type Change =
  | { readonly kind: 'new' }
  | { readonly kind: 'change'; readonly deltaMinor: number; readonly percent: number };

export function changeOf(prevMinor: number, curMinor: number): Change {
  const percent = percentChange(prevMinor, curMinor);
  return percent === undefined
    ? { kind: 'new' }
    : { kind: 'change', deltaMinor: curMinor - prevMinor, percent };
}

export interface CategoryDelta extends CategoryLine {
  readonly change: Change;
}

// Each current line with its change against the same category (by id; null is the
// uncategorized line) in `previous`, in the current order. A category spent on only before
// isn't listed.
export function periodDeltas(
  current: readonly CategoryLine[],
  previous: readonly CategoryLine[],
): CategoryDelta[] {
  const before = new Map(previous.map((line) => [line.categoryId, line.amountMinor]));
  return current.map((line) => ({
    ...line,
    change: changeOf(before.get(line.categoryId) ?? 0, line.amountMinor),
  }));
}

// What an expense is ranked by: its amount converted into the report's currency.
export interface Ranked {
  readonly id: string;
  readonly occurredAt: Date;
  readonly convertedMinor: number;
}

// The `n` largest by converted amount, largest first; a tie goes to the earlier `occurredAt`,
// then the smaller id.
export function topExpenses<T extends Ranked>(items: readonly T[], n: number): T[] {
  return [...items]
    .sort((a, b) => {
      if (a.convertedMinor !== b.convertedMinor) return b.convertedMinor - a.convertedMinor;
      const at = a.occurredAt.getTime() - b.occurredAt.getTime();
      if (at !== 0) return at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, n);
}

// The first `keep` lines, and what the rest add up to; `rest` is undefined when nothing is cut.
export function collapseTail<T extends { readonly amountMinor: number }>(
  lines: readonly T[],
  keep: number,
): { readonly shown: readonly T[]; readonly rest?: { count: number; amountMinor: number } } {
  if (lines.length <= keep) return { shown: lines };
  const cut = lines.slice(keep);
  const amountMinor = cut.reduce((sum, line) => {
    const total = sum + line.amountMinor;
    if (!Number.isSafeInteger(total)) throw new RangeError('total exceeds the safe integer range');
    return total;
  }, 0);
  return { shown: lines.slice(0, keep), rest: { count: cut.length, amountMinor } };
}
