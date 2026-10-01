import { minorFromDecimal } from '../money.js';
import { field, list, numberSource, parseJsonKeepingNumbers, text } from './json.js';
import type { FetchedItem } from './types.js';

// The Serbian tax site's answers (suf.purs.gov.rs, undocumented). Each parser returns undefined
// for anything it can't read in full, which fails the fetch.

export interface RsVerify {
  readonly sellerName: string;
  readonly totalMinor: number;
  readonly invoiceNumber: string;
}

// The verify URL fetched with `Accept: application/json`: the shop and the total.
export function parseRsVerify(body: string): RsVerify | undefined {
  const json = parseJsonKeepingNumbers(body);
  const request = field(json, 'invoiceRequest');
  const result = field(json, 'invoiceResult');
  const sellerName =
    nonEmpty(text(field(request, 'locationName'))) ??
    nonEmpty(text(field(request, 'businessName')));
  const total = numberSource(field(result, 'totalAmount'));
  const invoiceNumber = nonEmpty(text(field(result, 'invoiceNumber')));
  if (sellerName === undefined || total === undefined || invoiceNumber === undefined) {
    return undefined;
  }
  const totalMinor = minorFromDecimal(total, 'RSD');
  return totalMinor === undefined ? undefined : { sellerName, totalMinor, invoiceNumber };
}

// The verify page's HTML carries the token the specifications request needs.
export function parseRsToken(html: string): string | undefined {
  return /viewModel\.Token\('([^']+)'\)/.exec(html)?.[1];
}

// The `/specifications` answer: the line items, in receipt order.
export function parseRsSpecifications(body: string): readonly FetchedItem[] | undefined {
  const json = parseJsonKeepingNumbers(body);
  if (field(json, 'success') !== true) return undefined;
  const items = list(field(json, 'items'));
  if (items === undefined || items.length === 0) return undefined;
  const parsed: FetchedItem[] = [];
  for (const item of items) {
    const name = nonEmpty(text(field(item, 'name')));
    const quantity = numberSource(field(item, 'quantity'));
    const total = numberSource(field(item, 'total'));
    const totalMinor = total === undefined ? undefined : minorFromDecimal(total, 'RSD');
    if (name === undefined || quantity === undefined || totalMinor === undefined) return undefined;
    parsed.push({ name, quantity, totalMinor });
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
