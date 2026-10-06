import { describe, expect, it } from 'vitest';
import { changeOf, collapseTail, percentChange, periodDeltas, topExpenses } from './deltas.js';

describe('percentChange', () => {
  it('rounds 310000 × 100 / 930000 = 33.33 to 33', () => {
    expect(percentChange(930000, 1240000)).toBe(33);
  });

  it('gives −25 for 1240000 down to 930000', () => {
    expect(percentChange(1240000, 930000)).toBe(-25);
  });

  it('rounds a half away from zero, both ways', () => {
    // 1 × 100 / 200 = 0.5 and 3 × 100 / 200 = 1.5.
    expect(percentChange(200, 201)).toBe(1);
    expect(percentChange(200, 199)).toBe(-1);
    expect(percentChange(200, 203)).toBe(2);
    expect(percentChange(200, 197)).toBe(-2);
    // 0.4 stays 0.
    expect(percentChange(1000, 1004)).toBe(0);
  });

  it('is 0 for no change, −100 for nothing spent now', () => {
    expect(percentChange(5000, 5000)).toBe(0);
    expect(percentChange(5000, 0)).toBe(-100);
  });

  it('is undefined with nothing before', () => {
    expect(percentChange(0, 5000)).toBeUndefined();
  });

  it('stays exact past 2^53 / 100', () => {
    // 2^51 × 100 is past 2^53, where a double stops holding every integer.
    const prev = 2 ** 51;
    expect(percentChange(prev, prev * 2)).toBe(100);
  });
});

describe('changeOf', () => {
  it('carries the signed difference and the percent', () => {
    expect(changeOf(930000, 1240000)).toEqual({ kind: 'change', deltaMinor: 310000, percent: 33 });
    expect(changeOf(1240000, 930000)).toEqual({
      kind: 'change',
      deltaMinor: -310000,
      percent: -25,
    });
  });

  it('is new when nothing was spent before', () => {
    expect(changeOf(0, 1240000)).toEqual({ kind: 'new' });
  });
});

describe('periodDeltas', () => {
  it('matches categories by id, the uncategorized line by null, in the current order', () => {
    const deltas = periodDeltas(
      [
        { categoryId: 1, name: 'Кафе', amountMinor: 1240000 },
        { categoryId: 2, name: 'Такси', amountMinor: 50000 },
        { categoryId: null, name: null, amountMinor: 1000 },
      ],
      [
        { categoryId: null, name: null, amountMinor: 2000 },
        { categoryId: 1, name: 'Кафе', amountMinor: 930000 },
        { categoryId: 3, name: 'Книги', amountMinor: 70000 },
      ],
    );

    expect(deltas).toEqual([
      {
        categoryId: 1,
        name: 'Кафе',
        amountMinor: 1240000,
        change: { kind: 'change', deltaMinor: 310000, percent: 33 },
      },
      { categoryId: 2, name: 'Такси', amountMinor: 50000, change: { kind: 'new' } },
      {
        categoryId: null,
        name: null,
        amountMinor: 1000,
        change: { kind: 'change', deltaMinor: -1000, percent: -50 },
      },
    ]);
  });
});

describe('topExpenses', () => {
  const at = (iso: string) => new Date(iso);

  it('takes the three largest converted amounts, largest first', () => {
    const items = [
      { id: 'a', occurredAt: at('2026-09-01T10:00:00Z'), convertedMinor: 500 },
      { id: 'b', occurredAt: at('2026-09-02T10:00:00Z'), convertedMinor: 117500 },
      { id: 'c', occurredAt: at('2026-09-03T10:00:00Z'), convertedMinor: 90000 },
      { id: 'd', occurredAt: at('2026-09-04T10:00:00Z'), convertedMinor: 100000 },
    ];

    expect(topExpenses(items, 3).map((e) => e.id)).toEqual(['b', 'd', 'c']);
  });

  it('breaks a tie by the earlier occurredAt, then the smaller id', () => {
    const items = [
      { id: 'z', occurredAt: at('2026-09-02T10:00:00Z'), convertedMinor: 1000 },
      { id: 'y', occurredAt: at('2026-09-01T10:00:00Z'), convertedMinor: 1000 },
      { id: 'x', occurredAt: at('2026-09-02T10:00:00Z'), convertedMinor: 1000 },
    ];

    expect(topExpenses(items, 3).map((e) => e.id)).toEqual(['y', 'x', 'z']);
  });
});

describe('collapseTail', () => {
  const lines = [500, 400, 300, 200, 100].map((amountMinor) => ({ amountMinor }));

  it('keeps the first lines and sums the rest', () => {
    expect(collapseTail(lines, 3)).toEqual({
      shown: lines.slice(0, 3),
      rest: { count: 2, amountMinor: 300 },
    });
  });

  it('cuts nothing when the lines fit', () => {
    expect(collapseTail(lines, 5)).toEqual({ shown: lines });
  });
});
