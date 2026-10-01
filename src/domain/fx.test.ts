import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from './currencies.js';
import { convert, parseRateE4, type Rate } from './fx.js';

// The NBS middle rate list of 2026-09-28 (list 184).
const RATES: Partial<Record<CurrencyCode, Rate>> = {
  EUR: { unit: 1, middleE4: 1174993 },
  USD: { unit: 1, middleE4: 1031782 },
  JPY: { unit: 100, middleE4: 654009 },
};
const rateOf = (currency: CurrencyCode) => RATES[currency];

describe('parseRateE4', () => {
  it('reads four fraction digits into an integer', () => {
    expect(parseRateE4('117.4993')).toBe(1174993);
    expect(parseRateE4('0.5000')).toBe(5000);
  });

  it.each(['117.499', '117,4993', '1e2', '', '117.49930', '-1.0000', '0.0000', ' 1.0000'])(
    'refuses %j',
    (text) => {
      expect(parseRateE4(text)).toBeUndefined();
    },
  );
});

describe('convert', () => {
  it.each<[number, CurrencyCode, CurrencyCode, number]>([
    // 61906.92
    [600, 'USD', 'RSD', 61907],
    // 1261942.482
    [10740, 'EUR', 'RSD', 1261942],
    // 98101.35: unit 100, exponent 0
    [1500, 'JPY', 'RSD', 98101],
    // 526.87: the cross through RSD
    [600, 'USD', 'EUR', 527],
    // 382.98
    [45000, 'RSD', 'EUR', 383],
  ])('%i %s -> %s is %i minor', (amountMinor, currency, target, expected) => {
    expect(convert({ amountMinor, currency }, target, rateOf)).toEqual({
      amountMinor: expected,
      currency: target,
    });
  });

  it('rounds an exact half up', () => {
    const tie = () => ({ unit: 1, middleE4: 10050 });
    expect(convert({ amountMinor: 100, currency: 'EUR' }, 'RSD', tie)).toEqual({
      amountMinor: 101,
      currency: 'RSD',
    });
  });

  it('returns money already in the target unchanged, with no rates at all', () => {
    expect(convert({ amountMinor: 45000, currency: 'RSD' }, 'RSD', () => undefined)).toEqual({
      amountMinor: 45000,
      currency: 'RSD',
    });
  });

  it('is undefined when either side lacks a rate', () => {
    expect(convert({ amountMinor: 500000, currency: 'KZT' }, 'RSD', rateOf)).toBeUndefined();
    expect(convert({ amountMinor: 45000, currency: 'RSD' }, 'KZT', rateOf)).toBeUndefined();
  });
});
