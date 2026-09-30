import { describe, expect, it } from 'vitest';
import { sumByCurrency, summarizeByCurrencyAndCategory } from './aggregate.js';

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

describe('summarizeByCurrencyAndCategory', () => {
  const groceries = { id: 1, name: 'Продукты' };
  const cafe = { id: 2, name: 'Кафе и рестораны' };
  const transport = { id: 3, name: 'Транспорт' };

  it('totals each currency and splits it by category, largest first', () => {
    const summary = summarizeByCurrencyAndCategory(
      [
        { amountMinor: 45000, currency: 'RSD', category: cafe },
        { amountMinor: 120000, currency: 'RSD', category: groceries },
        { amountMinor: 1250, currency: 'EUR', category: transport },
        { amountMinor: 30000, currency: 'RSD', category: cafe },
        { amountMinor: 20000, currency: 'RSD', category: transport },
        { amountMinor: 7000, currency: 'RSD', category: null },
      ],
      'RSD',
    );

    expect(summary).toEqual([
      {
        currency: 'RSD',
        totalMinor: 222000,
        lines: [
          { categoryId: 1, name: 'Продукты', amountMinor: 120000 },
          { categoryId: 2, name: 'Кафе и рестораны', amountMinor: 75000 },
          { categoryId: 3, name: 'Транспорт', amountMinor: 20000 },
          { categoryId: null, name: null, amountMinor: 7000 },
        ],
      },
      {
        currency: 'EUR',
        totalMinor: 1250,
        lines: [{ categoryId: 3, name: 'Транспорт', amountMinor: 1250 }],
      },
    ]);
    const [rsd] = summary;
    expect(rsd?.lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(rsd?.totalMinor);
  });

  it('puts the first currency first and the others alphabetically', () => {
    const summary = summarizeByCurrencyAndCategory(
      [
        { amountMinor: 1, currency: 'USD', category: null },
        { amountMinor: 1, currency: 'EUR', category: null },
        { amountMinor: 1, currency: 'RSD', category: null },
        { amountMinor: 1, currency: 'GBP', category: null },
      ],
      'RSD',
    );
    expect(summary.map((s) => s.currency)).toEqual(['RSD', 'EUR', 'GBP', 'USD']);
  });

  it('sorts a tie by name in Russian collation, uncategorized last', () => {
    const summary = summarizeByCurrencyAndCategory(
      [
        { amountMinor: 100000, currency: 'RSD', category: null },
        { amountMinor: 100000, currency: 'RSD', category: { id: 7, name: 'Одежда' } },
        { amountMinor: 100000, currency: 'RSD', category: { id: 5, name: 'Здоровье' } },
      ],
      'RSD',
    );
    expect(summary[0]?.lines.map((line) => line.name)).toEqual(['Здоровье', 'Одежда', null]);
  });

  it('is empty for no items', () => {
    expect(summarizeByCurrencyAndCategory([], 'RSD')).toEqual([]);
  });

  it('throws rather than lose precision past the safe integer range', () => {
    expect(() =>
      summarizeByCurrencyAndCategory(
        [
          { amountMinor: Number.MAX_SAFE_INTEGER, currency: 'RSD', category: groceries },
          { amountMinor: 1, currency: 'RSD', category: cafe },
        ],
        'RSD',
      ),
    ).toThrow(RangeError);
  });
});
