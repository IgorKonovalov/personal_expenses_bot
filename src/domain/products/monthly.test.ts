import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../time.js';
import { monthLines, totalLines, type PricedItem } from './monthly.js';

const item = (day: string, totalMinor: number, amount: bigint | undefined): PricedItem => ({
  occurredOn: day as LocalDate,
  currency: 'RSD',
  totalMinor,
  amount,
});

// The plan's milks: items 1, 2, 3 and 7.
const MILK = [
  item('2026-09-12', 27800, 2_000_000n),
  item('2026-10-02', 15800, 1_000_000n),
  item('2026-10-05', 14900, 1_000_000n),
  item('2026-10-05', 15000, undefined),
];

describe('monthLines', () => {
  it('prices October at 15350 over 2 l, with item 7 in spend only, and September at 13900', () => {
    expect(monthLines(MILK, 'l')).toEqual([
      {
        month: '2026-10',
        currency: 'RSD',
        spentMinor: 45700,
        sizedMinor: 30700,
        amount: 2_000_000n,
        unsized: 1,
        unitPriceMinor: 15350,
      },
      {
        month: '2026-09',
        currency: 'RSD',
        spentMinor: 27800,
        sizedMinor: 27800,
        amount: 2_000_000n,
        unsized: 0,
        unitPriceMinor: 13900,
      },
    ]);
  });

  it('keeps currencies apart and has no price for a month with no sized item', () => {
    const lines = monthLines(
      [
        item('2026-10-05', 15000, undefined),
        { ...item('2026-10-05', 250, 1_000_000n), currency: 'EUR' },
      ],
      'l',
    );

    expect(lines.map((l) => [l.currency, l.spentMinor, l.unitPriceMinor])).toEqual([
      ['EUR', 250, 250],
      ['RSD', 15000, undefined],
    ]);
  });
});

describe('totalLines', () => {
  it('prices all time over the sized items only: 58500 over 4 l is 14625', () => {
    expect(totalLines(MILK, 'l')).toEqual([
      {
        currency: 'RSD',
        spentMinor: 73500,
        sizedMinor: 58500,
        amount: 4_000_000n,
        unsized: 1,
        unitPriceMinor: 14625,
      },
    ]);
  });
});
