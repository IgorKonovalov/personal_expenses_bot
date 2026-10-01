import type { CurrencyCode } from './currencies.js';
import type { Money } from './money.js';

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

export interface AuthoredMoney extends Money {
  // Who recorded it: an opaque id, named by the adapter.
  readonly createdBy: string;
}

export interface AuthorSummary {
  readonly authorId: string;
  // One entry per currency the author spent in, `firstCurrency` first, then alphabetically.
  // Each is that currency's sum alone: currencies are never added together (ADR-0003).
  readonly totals: readonly Money[];
}

// Per author, the totals per currency. Authors are ordered by their `firstCurrency` total,
// largest first, then by id; an author with none of it sorts after those who have some.
export function summarizeByAuthor(
  items: Iterable<AuthoredMoney>,
  firstCurrency: CurrencyCode,
): AuthorSummary[] {
  const byAuthor = new Map<string, AuthoredMoney[]>();
  for (const item of items) {
    const list = byAuthor.get(item.createdBy) ?? [];
    list.push(item);
    byAuthor.set(item.createdBy, list);
  }
  const first = (author: AuthorSummary) =>
    author.totals.find((t) => t.currency === firstCurrency)?.amountMinor ?? -1;
  return [...byAuthor]
    .map(([authorId, list]) => ({
      authorId,
      totals: [...sumByCurrency(list)]
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
        .sort((a, b) => currencyOrder(a.currency, b.currency, firstCurrency)),
    }))
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
