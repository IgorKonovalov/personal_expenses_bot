import type { CurrencyCode } from './currencies.js';
import { convert, type RateOf } from './fx.js';
import type { Money } from './money.js';
import type { LocalDate } from './time.js';

// Totals per currency, in first-seen order. Never adds across currencies (ADR-0003).
export function sumByCurrency(items: Iterable<Money>): ReadonlyMap<CurrencyCode, number> {
  const totals = new Map<CurrencyCode, number>();
  for (const { amountMinor, currency } of items) {
    const total = (totals.get(currency) ?? 0) + amountMinor;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError(`${currency} total exceeds the safe integer range`);
    }
    totals.set(currency, total);
  }
  return totals;
}

export interface CategorizedMoney extends Money {
  // null for an expense without a category.
  readonly category: { readonly id: number; readonly name: string } | null;
}

export interface CategoryLine {
  readonly categoryId: number | null;
  // null for the expenses without a category; the adapter names that line.
  readonly name: string | null;
  readonly amountMinor: number;
}

export interface CurrencySummary {
  readonly currency: CurrencyCode;
  // The sum of `lines`, an integer in minor units.
  readonly totalMinor: number;
  // By amount, largest first; a tie sorts by name (`ru` collation), the uncategorized line last.
  readonly lines: readonly CategoryLine[];
}

// Per currency, the total and its split by category. `firstCurrency` (the ledger default) comes
// first when present, the other currencies follow alphabetically. Never adds across currencies
// (ADR-0003).
export function summarizeByCurrencyAndCategory(
  items: Iterable<CategorizedMoney>,
  firstCurrency: CurrencyCode,
): CurrencySummary[] {
  const byCurrency = new Map<CurrencyCode, Map<number | null, CategoryLine>>();
  for (const { amountMinor, currency, category } of items) {
    const lines = byCurrency.get(currency) ?? new Map<number | null, CategoryLine>();
    byCurrency.set(currency, lines);
    const key = category?.id ?? null;
    const line = lines.get(key);
    lines.set(key, {
      categoryId: key,
      name: category?.name ?? null,
      amountMinor: safeSum(currency, line?.amountMinor ?? 0, amountMinor),
    });
  }

  return [...byCurrency]
    .map(([currency, lines]) => {
      const sorted = [...lines.values()].sort(byAmountThenName);
      const totalMinor = sorted.reduce(
        (total, line) => safeSum(currency, total, line.amountMinor),
        0,
      );
      return { currency, totalMinor, lines: sorted };
    })
    .sort((a, b) => currencyOrder(a.currency, b.currency, firstCurrency));
}

export interface DatedMoney extends CategorizedMoney {
  // The local day whose rate converts it (ADR-0022).
  readonly occurredOn: LocalDate;
}

export interface ConvertedSummary {
  // Everything with a rate, in `target`: each expense converted and rounded before any sum.
  // Undefined when no expense converts.
  readonly converted: CurrencySummary | undefined;
  // The original totals of the foreign expenses inside `converted`, alphabetically.
  readonly convertedFrom: readonly Money[];
  // Per currency, the expenses with no rate, alphabetically, never added to anything.
  readonly unconverted: readonly CurrencySummary[];
}

// One total in `target`, converted at each expense's day rate (ADR-0022). An expense already in
// `target` counts as is; one with no rate stays in its own currency's block.
export function summarizeConverted(
  items: Iterable<DatedMoney>,
  target: CurrencyCode,
  rateOf: RateOf,
): ConvertedSummary {
  const inTarget: CategorizedMoney[] = [];
  const foreign: Money[] = [];
  const unconverted: CategorizedMoney[] = [];
  for (const item of items) {
    const converted = convert(item, target, (currency) => rateOf(currency, item.occurredOn));
    if (converted === undefined) {
      unconverted.push(item);
      continue;
    }
    inTarget.push({ ...converted, category: item.category });
    if (item.currency !== target) foreign.push(item);
  }
  return {
    converted: summarizeByCurrencyAndCategory(inTarget, target)[0],
    convertedFrom: [...sumByCurrency(foreign)]
      .map(([currency, amountMinor]) => ({ currency, amountMinor }))
      .sort((a, b) => currencyOrder(a.currency, b.currency, target)),
    unconverted: summarizeByCurrencyAndCategory(unconverted, target),
  };
}

export interface AuthoredMoney extends Money {
  // Who recorded it: an opaque id, named by the adapter.
  readonly createdBy: string;
}

export interface ConvertedAuthorSummary {
  readonly authorId: string;
  // Everything of theirs with a rate, in the target; undefined when nothing converts.
  readonly converted: Money | undefined;
  // True when `converted` holds any foreign expense.
  readonly anyConverted: boolean;
  // Their totals with no rate, per currency, alphabetically.
  readonly unconverted: readonly Money[];
}

// Per author, one total in `target` at each expense's day rate (ADR-0022), each expense rounded
// before the sum, plus the totals of what had no rate. Authors are ordered by the converted
// total, largest first, then by id; an author with nothing converted sorts after the others.
export function summarizeByAuthorConverted(
  items: Iterable<AuthoredMoney & { readonly occurredOn: LocalDate }>,
  target: CurrencyCode,
  rateOf: RateOf,
): ConvertedAuthorSummary[] {
  const byAuthor = new Map<
    string,
    { converted: Money[]; foreign: boolean; unconverted: Money[] }
  >();
  for (const item of items) {
    const author = byAuthor.get(item.createdBy) ?? {
      converted: [],
      foreign: false,
      unconverted: [],
    };
    byAuthor.set(item.createdBy, author);
    const converted = convert(item, target, (currency) => rateOf(currency, item.occurredOn));
    if (converted === undefined) {
      author.unconverted.push(item);
      continue;
    }
    author.converted.push(converted);
    if (item.currency !== target) author.foreign = true;
  }
  const first = (author: ConvertedAuthorSummary) => author.converted?.amountMinor ?? -1;
  return [...byAuthor]
    .map(([authorId, { converted, foreign, unconverted }]) => {
      const total = sumByCurrency(converted).get(target);
      return {
        authorId,
        converted: total === undefined ? undefined : { currency: target, amountMinor: total },
        anyConverted: foreign,
        unconverted: [...sumByCurrency(unconverted)]
          .map(([currency, amountMinor]) => ({ currency, amountMinor }))
          .sort((a, b) => currencyOrder(a.currency, b.currency, target)),
      };
    })
    .sort((a, b) =>
      first(a) !== first(b)
        ? first(b) - first(a)
        : a.authorId < b.authorId
          ? -1
          : a.authorId > b.authorId
            ? 1
            : 0,
    );
}

function currencyOrder(a: CurrencyCode, b: CurrencyCode, first: CurrencyCode): number {
  if (a === b) return 0;
  if (a === first) return -1;
  if (b === first) return 1;
  return a < b ? -1 : 1;
}

function byAmountThenName(a: CategoryLine, b: CategoryLine): number {
  if (a.amountMinor !== b.amountMinor) return b.amountMinor - a.amountMinor;
  if (a.name === null) return b.name === null ? 0 : 1;
  if (b.name === null) return -1;
  return a.name.localeCompare(b.name, 'ru');
}

function safeSum(currency: CurrencyCode, a: number, b: number): number {
  const total = a + b;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${currency} total exceeds the safe integer range`);
  }
  return total;
}
