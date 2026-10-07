import { describe, expect, it } from 'vitest';
import { cumulativeByDay, type DatedAmount } from './pace.js';
import type { LocalDate } from './time.js';

const on = (occurredOn: string, amountMinor: number): DatedAmount => ({
  occurredOn: occurredOn as LocalDate,
  amountMinor,
});
const day = (date: string) => date as LocalDate;

describe('cumulativeByDay', () => {
  it('sums by day through `through`, with no gap for a day with nothing spent', () => {
    const items = [
      on('2026-10-01', 1000),
      on('2026-10-01', 500),
      on('2026-10-03', 2000),
      // After `through`: not counted.
      on('2026-10-05', 9000),
    ];

    expect(cumulativeByDay(items, day('2026-10-01'), 5, day('2026-10-04'))).toEqual([
      1500, 1500, 3500, 3500,
    ]);
  });

  it('stops at the period end when `through` is past it', () => {
    const items = [on('2026-10-02', 700), on('2026-10-04', 100)];

    expect(cumulativeByDay(items, day('2026-10-01'), 3, day('2026-10-09'))).toEqual([0, 700, 700]);
  });

  it('is empty before the period starts, and ignores an item dated before it', () => {
    expect(cumulativeByDay([on('2026-09-30', 5)], day('2026-10-01'), 3, day('2026-09-30'))).toEqual(
      [],
    );
    expect(cumulativeByDay([on('2026-09-30', 5)], day('2026-10-01'), 3, day('2026-10-01'))).toEqual(
      [0],
    );
  });

  it('refuses a sum beyond the safe integer range', () => {
    const items = [on('2026-10-01', Number.MAX_SAFE_INTEGER), on('2026-10-02', 1)];

    expect(() => cumulativeByDay(items, day('2026-10-01'), 2, day('2026-10-02'))).toThrow(
      RangeError,
    );
  });
});
