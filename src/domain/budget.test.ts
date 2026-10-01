import { describe, expect, it } from 'vitest';
import { allowanceThrough, countInto, dayOfPeriod, isSafeLimit, remainders } from './budget.js';
import type { CurrencyCode } from './currencies.js';
import type { Rate, RateOf } from './fx.js';
import type { LocalDate } from './time.js';

describe('allowanceThrough (ADR-0017)', () => {
  it('is floor(L * d / N) for L = 3_000_000 over 31 days', () => {
    expect(allowanceThrough(3_000_000, 31, 1)).toBe(96_774);
    expect(allowanceThrough(3_000_000, 31, 2)).toBe(193_548);
    expect(allowanceThrough(3_000_000, 31, 31)).toBe(3_000_000);
  });

  it('is floor(L * d / N) for L = 1_000_000 over 30 days', () => {
    expect(allowanceThrough(1_000_000, 30, 1)).toBe(33_333);
    expect(allowanceThrough(1_000_000, 30, 2)).toBe(66_666);
    expect(allowanceThrough(1_000_000, 30, 30)).toBe(1_000_000);
  });

  it.each([
    [3_000_000, 31],
    [1_000_000, 30],
  ])('is monotonic over every day of L = %i, N = %i', (limit, days) => {
    for (let day = 2; day <= days; day++) {
      expect(allowanceThrough(limit, days, day)).toBeGreaterThanOrEqual(
        allowanceThrough(limit, days, day - 1),
      );
    }
  });

  it('refuses a limit whose L * N leaves the safe integer range, and a day past N', () => {
    expect(() => allowanceThrough(Number.MAX_SAFE_INTEGER, 31, 1)).toThrow(RangeError);
    expect(() => allowanceThrough(1_000_000, 30, 31)).toThrow(RangeError);
    expect(isSafeLimit(Math.floor(Number.MAX_SAFE_INTEGER / 31))).toBe(true);
    expect(isSafeLimit(Math.floor(Number.MAX_SAFE_INTEGER / 31) + 1)).toBe(false);
  });
});

describe('remainders', () => {
  it('subtracts spend through today from the cumulative allowance, overspend negative', () => {
    expect(
      remainders({
        limitMinor: 3_000_000,
        days: 31,
        day: 1,
        spentThroughTodayMinor: 150_000,
        spentInPeriodMinor: 150_000,
      }),
    ).toEqual({ todayLeftMinor: -53_226, periodLeftMinor: 2_850_000 });
  });
});

describe('countInto (ADR-0023)', () => {
  const SEPT_28 = '2026-09-28' as LocalDate;
  // The NBS middle rate list of 2026-09-28, in force on the 28th only.
  const RATES: Partial<Record<CurrencyCode, Rate>> = {
    EUR: { unit: 1, middleE4: 1174993 },
    USD: { unit: 1, middleE4: 1031782 },
  };
  const rateOf: RateOf = (currency, day) => (day === SEPT_28 ? RATES[currency] : undefined);

  it('counts the budget currency as is and converts the rest, each rounded', () => {
    const split = countInto(
      [
        { amountMinor: 45_000, currency: 'RSD', occurredOn: SEPT_28 },
        // 61 906.92 -> 61 907
        { amountMinor: 600, currency: 'USD', occurredOn: SEPT_28 },
        // 1 261 942.482 -> 1 261 942
        { amountMinor: 10_740, currency: 'EUR', occurredOn: SEPT_28 },
      ],
      'RSD',
      rateOf,
    );
    expect(split).toEqual({
      countedMinor: 1_368_849,
      converted: true,
      notCounted: new Map(),
    });
  });

  it('lists what has no rate apart and counts nothing of it', () => {
    const split = countInto(
      [
        { amountMinor: 30_000, currency: 'RSD', occurredOn: SEPT_28 },
        { amountMinor: 500_000, currency: 'KZT', occurredOn: SEPT_28 },
        { amountMinor: 250, currency: 'EUR', occurredOn: '2026-09-20' as LocalDate },
      ],
      'RSD',
      rateOf,
    );
    expect(split).toEqual({
      countedMinor: 30_000,
      converted: false,
      notCounted: new Map([
        ['KZT', 500_000],
        ['EUR', 250],
      ]),
    });
  });

  it('converts RSD into a EUR budget: 450.00 RSD is 3.83 EUR', () => {
    const split = countInto(
      [{ amountMinor: 45_000, currency: 'RSD', occurredOn: SEPT_28 }],
      'EUR',
      rateOf,
    );
    expect(split.countedMinor).toBe(383);
    expect(split.converted).toBe(true);
  });
});

describe('dayOfPeriod', () => {
  it('counts the first day as 1, across a month end', () => {
    expect(dayOfPeriod('2026-10-01' as LocalDate, '2026-10-01' as LocalDate)).toBe(1);
    expect(dayOfPeriod('2026-09-10' as LocalDate, '2026-10-09' as LocalDate)).toBe(30);
  });
});
