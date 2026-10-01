import { currencyExponent, type CurrencyCode } from './currencies.js';

// Amounts are integers in minor units (ADR-0004). This module is the only place that converts
// between typed text and minor units, and it does so on digit strings, never with float math.

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export interface AmountReading {
  readonly interpretation: 'thousands' | 'decimal';
  readonly amountMinor: number;
}

export type ParseAmountResult =
  | { readonly kind: 'ok'; readonly amountMinor: number }
  // A single `.`/`,` followed by exactly three digits. Only the readings valid for the
  // currency are listed (at least one).
  | { readonly kind: 'ambiguous'; readonly readings: readonly AmountReading[] }
  | { readonly kind: 'invalid' };

// Regular space, NBSP, thin space, narrow NBSP.
const GROUP_SEPARATOR = /[ \u00A0\u2009\u202F]/g;
const INTEGER_PART = /^(?:\d+|[1-9]\d{0,2}(?:[ \u00A0\u2009\u202F]\d{3})+)$/;
const SHORT_INTEGER = /^[1-9]\d{0,2}$/;

export function parseAmount(token: string, currency: CurrencyCode): ParseAmountResult {
  const exponent = currencyExponent(currency);
  const match = /^([^.,]+)(?:([.,])(\d+))?$/.exec(token);
  if (match === null) return INVALID;
  const [, integerPart = '', separator, fraction] = match;
  if (!INTEGER_PART.test(integerPart)) return INVALID;
  const integerDigits = integerPart.replace(GROUP_SEPARATOR, '');

  if (separator === undefined || fraction === undefined) {
    return result(toMinor(integerDigits, '', exponent));
  }

  if (fraction.length === 3) {
    const readings: AmountReading[] = [];
    if (SHORT_INTEGER.test(integerPart)) {
      const thousands = toMinor(integerDigits + fraction, '', exponent);
      if (thousands !== undefined)
        readings.push({ interpretation: 'thousands', amountMinor: thousands });
    }
    const decimal = decimalMinor(integerDigits, fraction, exponent);
    if (decimal !== undefined) readings.push({ interpretation: 'decimal', amountMinor: decimal });
    return readings.length === 0 ? INVALID : { kind: 'ambiguous', readings };
  }

  if (fraction.length > exponent) return INVALID;
  return result(toMinor(integerDigits, fraction, exponent));
}

// A machine-written decimal, e.g. a JSON number's source text (`799.99`, `-5`, `0.29`), to
// minor units, on the digits alone. Fraction digits past the currency's exponent must be zeros
// (`1.500` RSD is 150, `1.005` RSD is undefined). Zero is allowed: a free line item. Undefined
// for exponents, malformed text and anything beyond Number.MAX_SAFE_INTEGER.
export function minorFromDecimal(source: string, currency: CurrencyCode): number | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(source);
  if (match === null) return undefined;
  const [, sign = '', integerDigits = '', fraction = ''] = match;
  const exponent = currencyExponent(currency);
  if (!/^0*$/.test(fraction.slice(exponent))) return undefined;
  const digits = (integerDigits + fraction.slice(0, exponent).padEnd(exponent, '0')).replace(
    /^0+(?=\d)/,
    '',
  );
  if (digits.length > 15) return undefined;
  const minor = Number(digits);
  return sign === '-' && minor !== 0 ? -minor : minor;
}

// Formats with space-grouped thousands and a dot decimal: 120000 RSD -> `1 200.00 RSD`.
export function formatMoney({ amountMinor, currency }: Money): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('amountMinor must be a safe integer');
  }
  const exponent = currencyExponent(currency);
  const sign = amountMinor < 0 ? '-' : '';
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const integerDigits = digits.slice(0, digits.length - exponent);
  const grouped = integerDigits.replace(/\B(?=(\d{3})+$)/g, ' ');
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${sign}${grouped}${fraction} ${currency}`;
}

const INVALID: ParseAmountResult = { kind: 'invalid' };

function result(amountMinor: number | undefined): ParseAmountResult {
  return amountMinor === undefined ? INVALID : { kind: 'ok', amountMinor };
}

// The decimal reading of a three-digit fraction exists only when the digits past the
// currency's exponent are zeros: `1.200` RSD -> 120, `1.234` RSD -> none.
function decimalMinor(integerDigits: string, fraction: string, exponent: number) {
  const significant = fraction.slice(0, exponent);
  if (!/^0*$/.test(fraction.slice(exponent))) return undefined;
  return toMinor(integerDigits, significant, exponent);
}

// Concatenates integer digits and the fraction padded to the exponent. Rejects zero and
// anything beyond Number.MAX_SAFE_INTEGER.
function toMinor(integerDigits: string, fraction: string, exponent: number): number | undefined {
  const minorDigits = (integerDigits + fraction.padEnd(exponent, '0')).replace(/^0+/, '');
  if (minorDigits === '' || minorDigits.length > 15) return undefined;
  return Number(minorDigits);
}
