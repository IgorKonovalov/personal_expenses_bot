import type { CurrencyCode } from '../currencies.js';
import type { Money } from '../money.js';
import type { LocalDate } from '../time.js';

// A period's receipt items grouped by their expense's category (ADR-0038): an item has no
// category of its own. Pure: the service reads the rows, the bot renders the groups.

export interface PeriodItem {
  readonly name: string;
  // Decimal source text, as stored: a quantity, not money.
  readonly quantity: string;
  // Integer minor units of `currency`, the expense's currency.
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredOn: LocalDate;
  // Null for an expense without a category; such items form one group.
  readonly categoryId: number | null;
  readonly categoryName: string | null;
  // A stable order for items alike in name and date: the expense's id.
  readonly receiptKey: string;
  // 1-based, in the receipt's own order.
  readonly position: number;
}

export interface ItemGroup {
  readonly categoryId: number | null;
  readonly categoryName: string | null;
  // One per currency, never converted: the default currency first, then alphabetically.
  readonly totals: readonly Money[];
  readonly items: readonly PeriodItem[];
}

// Russian names compare case-insensitively, so «хлеб» and «Хлеб» sit together.
const names = new Intl.Collator('ru', { sensitivity: 'accent' });

function compareItems(a: PeriodItem, b: PeriodItem): number {
  return (
    names.compare(a.name, b.name) ||
    compareText(a.occurredOn, b.occurredOn) ||
    compareText(a.receiptKey, b.receiptKey) ||
    a.position - b.position
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Groups ordered by their total in `defaultCurrency`, largest first; a group with none of it
// comes after, by name, and the group without a category after the named ones. Items inside a
// group sort by name, then date, then receipt and position.
export function groupItems(
  items: readonly PeriodItem[],
  defaultCurrency: CurrencyCode,
): ItemGroup[] {
  const byCategory = new Map<number | null, PeriodItem[]>();
  for (const item of items) {
    const group = byCategory.get(item.categoryId);
    if (group === undefined) byCategory.set(item.categoryId, [item]);
    else group.push(item);
  }
  const groups = [...byCategory].map(([categoryId, members]): ItemGroup => {
    const [first] = members;
    return {
      categoryId,
      categoryName: first?.categoryName ?? null,
      totals: totalsOf(members, defaultCurrency),
      items: [...members].sort(compareItems),
    };
  });
  return groups.sort((a, b) => {
    const aDefault = defaultTotal(a, defaultCurrency);
    const bDefault = defaultTotal(b, defaultCurrency);
    if (aDefault !== undefined && bDefault !== undefined && aDefault !== bDefault) {
      return bDefault - aDefault;
    }
    if (aDefault !== undefined && bDefault === undefined) return -1;
    if (aDefault === undefined && bDefault !== undefined) return 1;
    return compareNames(a.categoryName, b.categoryName);
  });
}

function compareNames(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return names.compare(a, b);
}

function defaultTotal(group: ItemGroup, currency: CurrencyCode): number | undefined {
  return group.totals.find((total) => total.currency === currency)?.amountMinor;
}

// Integer sums per currency, never converted.
function totalsOf(items: readonly PeriodItem[], defaultCurrency: CurrencyCode): Money[] {
  const sums = new Map<CurrencyCode, number>();
  for (const { currency, totalMinor } of items) {
    sums.set(currency, (sums.get(currency) ?? 0) + totalMinor);
  }
  return [...sums]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) =>
      a.currency === defaultCurrency
        ? -1
        : b.currency === defaultCurrency
          ? 1
          : compareText(a.currency, b.currency),
    );
}
