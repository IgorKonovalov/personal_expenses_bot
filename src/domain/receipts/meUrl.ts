import { parseAmount } from '../money.js';
import type { DecodeReceiptResult, ReceiptRefusal } from './types.js';

// The Montenegrin fiscal receipt (EFI) verification URL. Its parameters sit in the hash
// fragment: `https://mapr.tax.gov.me/ic/#/verify?iic=<32 hex>&tin=<tin>&crtd=<ISO instant>&prc=<total>&bu=<unit>&…`.
// The total is EUR with a dot decimal; the currency is inferred, not printed (Plan 0014 risks).

const URL_PATTERN = /^https?:\/\/mapr\.tax\.gov\.me\/ic\/?#\/verify\?(\S*)$/i;
const IIC = /^[0-9a-f]{32}$/i;
const TIN = /^\d{8,13}$/;
const BUSINESS_UNIT = /^[a-z0-9]{1,20}$/i;
const PRICE = /^\d+(?:\.\d{1,2})?$/;
const OVERPRECISE_PRICE = /^\d+\.\d{3,}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function decodeMeUrl(text: string): DecodeReceiptResult {
  // A space inside the fragment is what form-style decoding makes of crtd's `+`, so the pattern
  // stops at whitespace only after it is put back.
  const match = URL_PATTERN.exec(
    text.trim().replace(/(T\d{2}:\d{2}:\d{2}) (\d{2}:\d{2})/, '$1+$2'),
  );
  if (match === null) return { kind: 'notReceipt' };
  const params = fragmentParams(match[1] ?? '');
  if (params === undefined) return refused('malformed');

  const iic = params.get('iic');
  const tin = params.get('tin');
  const crtd = normalizedInstant(params.get('crtd'));
  const prc = params.get('prc');
  const bu = params.get('bu');
  if (iic === undefined || !IIC.test(iic)) return refused('malformed');
  if (tin === undefined || !TIN.test(tin)) return refused('malformed');
  if (bu === undefined || !BUSINESS_UNIT.test(bu)) return refused('malformed');
  if (crtd === undefined) return refused('malformed');
  if (prc === undefined) return refused('malformed');
  if (OVERPRECISE_PRICE.test(prc)) return refused('fractionalTotal');
  if (!PRICE.test(prc)) return refused('malformed');
  const total = parseAmount(prc, 'EUR');
  if (total.kind !== 'ok') return refused('malformed');

  const fiscalId = iic.toLowerCase();
  const query = new URLSearchParams({ iic: fiscalId, tin, crtd, prc });
  return {
    kind: 'receipt',
    receipt: {
      country: 'ME',
      fiscalId,
      merchantKey: `me:${tin}:${bu}`,
      totalMinor: total.amountMinor,
      currency: 'EUR',
      issuedAt: new Date(crtd),
      verifyUrl: `https://mapr.tax.gov.me/ic/#/verify?${query.toString()}`,
    },
  };
}

// Percent-decoded values by name. A `+` stays a `+`: these are not form-encoded.
function fragmentParams(query: string): Map<string, string> | undefined {
  const params = new Map<string, string>();
  for (const part of query.split('&')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    try {
      params.set(part.slice(0, at), decodeURIComponent(part.slice(at + 1)));
    } catch {
      return undefined;
    }
  }
  return params;
}

// `2026-09-30T23:15:00+02:00`, also when its `+` arrived as a space.
function normalizedInstant(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const instant = raw.replace(/ (\d{2}:\d{2})$/, '+$1');
  if (!INSTANT.test(instant) || Number.isNaN(Date.parse(instant))) return undefined;
  return instant;
}

function refused(reason: ReceiptRefusal): DecodeReceiptResult {
  return { kind: 'refused', reason };
}
