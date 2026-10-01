import { describe, expect, it } from 'vitest';
import {
  allowanceThrough,
  dayOfPeriod,
  isSafeLimit,
  remainders,
  splitByCurrency,
} from './budget.js';
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

describe('splitByCurrency', () => {
  it('sums the budget currency and lists the others apart', () => {
    const split = splitByCurrency(
      [
        { amountMinor: 45_000, currency: 'RUB' },
        { amountMinor: 1_250, currency: 'EUR' },
        { amountMinor: 30_000, currency: 'RUB' },
        { amountMinor: 250, currency: 'EUR' },
      ],
      'RUB',
    );
    expect(split.countedMinor).toBe(75_000);
    expect([...split.notCounted]).toEqual([['EUR', 1_500]]);
  });
});

describe('dayOfPeriod', () => {
  it('counts the first day as 1, across a month end', () => {
    expect(dayOfPeriod('2026-10-01' as LocalDate, '2026-10-01' as LocalDate)).toBe(1);
    expect(dayOfPeriod('2026-09-10' as LocalDate, '2026-10-09' as LocalDate)).toBe(30);
  });
});
