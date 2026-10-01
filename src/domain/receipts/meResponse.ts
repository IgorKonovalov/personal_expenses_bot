import { minorFromDecimal } from '../money.js';
import { field, list, numberSource, parseJsonKeepingNumbers, text } from './json.js';
import type { FetchedItem, FetchedReceipt } from './types.js';

// The Montenegrin tax site's `verifyInvoice` answer (mapr.tax.gov.me, undocumented): the seller,
// the total and the items. Amounts are read as EUR, the currency the QR total is recorded in;
// a `currency.code` the site names is passed on for the caller to compare. Undefined for anything
// not read in full, which fails the fetch.
export function parseMeVerify(body: string): FetchedReceipt | undefined {
  const json = parseJsonKeepingNumbers(body);
  const sellerName = text(field(field(json, 'seller'), 'name'))?.trim();
  const total = numberSource(field(json, 'totalPrice'));
  const totalMinor = total === undefined ? undefined : minorFromDecimal(total, 'EUR');
  const items = list(field(json, 'items'));
  if (sellerName === undefined || sellerName === '' || totalMinor === undefined) return undefined;
  if (items === undefined || items.length === 0) return undefined;

  const parsed: FetchedItem[] = [];
  for (const item of items) {
    const name = text(field(item, 'name'))?.trim();
    const quantity = numberSource(field(item, 'quantity'));
    const lineTotal = numberSource(field(item, 'priceAfterVat'));
    const lineMinor = lineTotal === undefined ? undefined : minorFromDecimal(lineTotal, 'EUR');
    if (name === undefined || name === '' || quantity === undefined || lineMinor === undefined) {
      return undefined;
    }
    parsed.push({ name, quantity, totalMinor: lineMinor });
  }
  const currencyCode = text(field(field(json, 'currency'), 'code'));
  return {
    sellerName,
    totalMinor,
    ...(currencyCode === undefined ? {} : { currencyCode }),
    items: parsed,
  };
}
