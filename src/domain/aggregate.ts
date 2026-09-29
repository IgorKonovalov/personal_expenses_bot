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
