import { describe, expect, it } from 'vitest';
import {
  sumByCurrency,
  summarizeByAuthor,
  summarizeByCurrencyAndCategory,
  summarizeConverted,
} from './aggregate.js';
import type { CurrencyCode } from './currencies.js';
import type { Rate, RateOf } from './fx.js';
import type { LocalDate } from './time.js';

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

describe('summarizeByAuthor', () => {
  it('sums each author per currency, the largest first-currency total first', () => {
    expect(
      summarizeByAuthor(
        [
          { amountMinor: 45000, currency: 'RSD', createdBy: 'a' },
          { amountMinor: 30000, currency: 'RSD', createdBy: 'b' },
          { amountMinor: 120000, currency: 'RSD', createdBy: 'a' },
        ],
        'RSD',
      ),
    ).toEqual([
      { authorId: 'a', totals: [{ amountMinor: 165000, currency: 'RSD' }] },
      { authorId: 'b', totals: [{ amountMinor: 30000, currency: 'RSD' }] },
    ]);
  });

  // Property: each total is the sum of that author's amounts in that one currency, so 1250 EUR
  // minor units and 45000 RSD minor units stay two entries and are never added together.
  it('lists each currency of an author separately and never adds across currencies', () => {
    expect(
      summarizeByAuthor(
        [
          { amountMinor: 1250, currency: 'EUR', createdBy: 'a' },
          { amountMinor: 45000, currency: 'RSD', createdBy: 'a' },
          { amountMinor: 500, currency: 'USD', createdBy: 'a' },
          { amountMinor: 250, currency: 'EUR', createdBy: 'a' },
          { amountMinor: 999, currency: 'USD', createdBy: 'b' },
        ],
        'RSD',
      ),
    ).toEqual([
      {
        authorId: 'a',
        totals: [
          { amountMinor: 45000, currency: 'RSD' },
          { amountMinor: 1500, currency: 'EUR' },
          { amountMinor: 500, currency: 'USD' },
        ],
      },
      { authorId: 'b', totals: [{ amountMinor: 999, currency: 'USD' }] },
    ]);
  });

  it('is empty for no items', () => {
    expect(summarizeByAuthor([], 'RSD')).toEqual([]);
  });
});

describe('summarizeConverted', () => {
  const other = { id: 1, name: 'Другое' };
  const cafe = { id: 2, name: 'Кафе и рестораны' };
  const telecom = { id: 3, name: 'Связь и интернет' };
  const SEPT_28 = '2026-09-28' as LocalDate;
  // The NBS middle rate list of 2026-09-28, in force on the 28th only.
  const RATES: Partial<Record<CurrencyCode, Rate>> = {
    EUR: { unit: 1, middleE4: 1174993 },
    USD: { unit: 1, middleE4: 1031782 },
  };
  const rateOf: RateOf = (currency, day) => (day === SEPT_28 ? RATES[currency] : undefined);
  const week = [
    { amountMinor: 342000, currency: 'RSD', category: other, occurredOn: SEPT_28 },
    { amountMinor: 45000, currency: 'RSD', category: cafe, occurredOn: SEPT_28 },
    { amountMinor: 10740, currency: 'EUR', category: telecom, occurredOn: SEPT_28 },
    { amountMinor: 600, currency: 'USD', category: other, occurredOn: SEPT_28 },
  ] as const;

  it('sums the rounded converted parts into one total in the target', () => {
    expect(summarizeConverted(week, 'RSD', rateOf)).toEqual({
      // 1 261 942 + 403 907 + 45 000
      converted: {
        currency: 'RSD',
        totalMinor: 1710849,
        lines: [
          { categoryId: 3, name: 'Связь и интернет', amountMinor: 1261942 },
          { categoryId: 1, name: 'Другое', amountMinor: 403907 },
          { categoryId: 2, name: 'Кафе и рестораны', amountMinor: 45000 },
        ],
      },
      convertedFrom: [
        { currency: 'EUR', amountMinor: 10740 },
        { currency: 'USD', amountMinor: 600 },
      ],
      unconverted: [],
    });
  });

  it('keeps an expense with no rate in its own block', () => {
    const summary = summarizeConverted(
      [
        ...week,
        { amountMinor: 500000, currency: 'KZT', category: other, occurredOn: SEPT_28 },
        {
          amountMinor: 600,
          currency: 'USD',
          category: other,
          occurredOn: '2026-09-20' as LocalDate,
        },
      ],
      'RSD',
      rateOf,
    );
    expect(summary.converted?.totalMinor).toBe(1710849);
    expect(summary.unconverted).toEqual([
      {
        currency: 'KZT',
        totalMinor: 500000,
        lines: [{ categoryId: 1, name: 'Другое', amountMinor: 500000 }],
      },
      {
        currency: 'USD',
        totalMinor: 600,
        lines: [{ categoryId: 1, name: 'Другое', amountMinor: 600 }],
      },
    ]);
  });

  it('converts nothing and names nothing with no rates at all', () => {
    const summary = summarizeConverted(week, 'RSD', () => undefined);
    expect(summary.converted?.totalMinor).toBe(387000);
    expect(summary.convertedFrom).toEqual([]);
    expect(summary.unconverted.map((c) => [c.currency, c.totalMinor])).toEqual([
      ['EUR', 10740],
      ['USD', 600],
    ]);
  });

  it('has no converted block when nothing converts', () => {
    expect(
      summarizeConverted(
        [{ amountMinor: 500000, currency: 'KZT', category: null, occurredOn: SEPT_28 }],
        'RSD',
        rateOf,
      ).converted,
    ).toBeUndefined();
  });
});
