import { currencyExponent, type CurrencyCode } from './currencies.js';
import type { Money } from './money.js';
import type { LocalDate } from './time.js';

// An NBS middle rate: RSD per `unit` units of a currency, times 10^4, as an integer (ADR-0022).
export interface Rate {
  readonly unit: number;
  readonly middleE4: number;
}

// The rate in force for a currency on a day; undefined when there is none.
export type RateOf = (currency: CurrencyCode, day: LocalDate) => Rate | undefined;

// RSD is the pivot every NBS rate is quoted against.
const RSD_RATE: Rate = { unit: 1, middleE4: 10_000 };

// `117.4993` -> 1174993. Exactly four fraction digits and a dot, read digit by digit; anything
// else (`117.499`, `117,4993`, `1e2`, ``) is undefined.
export function parseRateE4(text: string): number | undefined {
  const match = /^(\d{1,9})\.(\d{4})$/.exec(text);
  if (match === null) return undefined;
  const [, integerDigits = '', fraction = ''] = match;
  const e4 = Number((integerDigits + fraction).replace(/^0+(?=\d)/, ''));
  return e4 > 0 ? e4 : undefined;
}

// `money` in `target` at the rates of one day, as one exact rational step rounded half-up (away
// from zero) to target's minor units:
//   amountMinor * (rateC / unitC) / (rateT / unitT) * 10^(expT - expC).
// Money already in `target` is returned unchanged and needs no rate. Undefined when either side
// has no rate. Throws past the safe integer range.
export function convert(
  money: Money,
  target: CurrencyCode,
  rateOf: (currency: CurrencyCode) => Rate | undefined,
): Money | undefined {
  if (money.currency === target) return money;
  const from = money.currency === 'RSD' ? RSD_RATE : rateOf(money.currency);
  const to = target === 'RSD' ? RSD_RATE : rateOf(target);
  if (from === undefined || to === undefined) return undefined;

  const numerator =
    BigInt(money.amountMinor) *
    BigInt(from.middleE4) *
    BigInt(to.unit) *
    10n ** BigInt(currencyExponent(target));
  const denominator =
    BigInt(from.unit) * BigInt(to.middleE4) * 10n ** BigInt(currencyExponent(money.currency));
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  const amountMinor = Number(numerator < 0n ? -rounded : rounded);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`${target} amount exceeds the safe integer range`);
  }
  return { amountMinor, currency: target };
}
