import { decodeMeUrl } from './meUrl.js';
import { decodeRsUrl } from './rsUrl.js';
import type { DecodeReceiptResult } from './types.js';

// A Serbian or Montenegrin receipt verification URL, decoded offline (ADR-0018). Text that is
// not one of them, whole, is `notReceipt`.
export function decodeReceiptUrl(text: string): DecodeReceiptResult {
  const rs = decodeRsUrl(text);
  return rs.kind === 'notReceipt' ? decodeMeUrl(text) : rs;
}
