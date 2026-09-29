import { describe, expect, it } from 'vitest';
import { sumByCurrency } from './aggregate.js';

describe('sumByCurrency', () => {
  it('sums per currency with integer arithmetic', () => {
    const totals = sumByCurrency([
      { amountMinor: 45000, currency: 'RSD' },
      { amountMinor: 1250, currency: 'RSD' },
      { amountMinor: 1250, currency: 'EUR' },
    ]);
    expect(Object.fromEntries(totals)).toEqual({ RSD: 46250, EUR: 1250 });
    expect([...totals.keys()]).toEqual(['RSD', 'EUR']);
  });

  it('is empty for no items', () => {
    expect(sumByCurrency([]).size).toBe(0);
  });

  it('throws rather than lose precision past the safe integer range', () => {
    expect(() =>
      sumByCurrency([
        { amountMinor: Number.MAX_SAFE_INTEGER, currency: 'RSD' },
        { amountMinor: 1, currency: 'RSD' },
      ]),
    ).toThrow(RangeError);
  });
});
