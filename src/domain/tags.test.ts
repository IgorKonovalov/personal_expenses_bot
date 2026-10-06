import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from './currencies.js';
import type { RateOf } from './fx.js';
import {
  decodeTags,
  encodeTags,
  findTagByHash,
  summarizeTag,
  summarizeTags,
  tagHash,
  toTagName,
  type TagName,
} from './tags.js';
import type { LocalDate } from './time.js';

const tag = (name: string) => name as TagName;

function item(
  amountMinor: number,
  currency: CurrencyCode,
  occurredOn: string,
  tags: readonly string[],
  at = `${occurredOn}T10:00:00Z`,
) {
  return {
    amountMinor,
    currency,
    category: null,
    occurredOn: occurredOn as LocalDate,
    occurredAt: new Date(at),
    tags: tags.map(tag),
  };
}

// EUR at 117.1234 RSD on 2026-09-30 only.
const rateOf: RateOf = (currency, day) =>
  currency === 'EUR' && day === '2026-09-30' ? { unit: 1, middleE4: 1171234 } : undefined;

describe('toTagName', () => {
  it('normalizes to NFC lower case and refuses anything but 1-32 letters, digits or _', () => {
    expect(toTagName('Отпуск')).toBe('отпуск');
    expect(toTagName('trip_2026')).toBe('trip_2026');
    expect(toTagName('')).toBeUndefined();
    expect(toTagName('a-b')).toBeUndefined();
    expect(toTagName('я'.repeat(33))).toBeUndefined();
  });
});

describe('encodeTags / decodeTags', () => {
  it('stores the names space-joined, and none as NULL', () => {
    expect(encodeTags([tag('отпуск'), tag('рим')])).toBe('отпуск рим');
    expect(encodeTags([])).toBeNull();
    expect(decodeTags('отпуск рим')).toEqual(['отпуск', 'рим']);
    expect(decodeTags(null)).toEqual([]);
  });
});

describe('summarizeTags', () => {
  it('converts each expense at its day rate before adding: 45000 + 146404 = 191404 RSD', () => {
    const totals = summarizeTags(
      [
        item(45000, 'RSD', '2026-09-30', ['отпуск']),
        // 1250 * 1171234 / 10000 = 146404.25, rounded to 146404.
        item(1250, 'EUR', '2026-09-30', ['отпуск']),
      ],
      'RSD',
      rateOf,
    );

    expect(totals).toEqual([
      {
        name: 'отпуск',
        converted: { amountMinor: 191404, currency: 'RSD' },
        unconverted: [],
        lastOn: '2026-09-30',
      },
    ]);
  });

  it('keeps a currency with no rate apart, and counts a two-tag expense under each', () => {
    const totals = summarizeTags(
      [
        item(1000, 'EUR', '2026-09-29', ['рим']),
        item(30000, 'RSD', '2026-09-28', ['рим', 'отпуск']),
      ],
      'RSD',
      rateOf,
    );

    expect(totals).toEqual([
      {
        name: 'рим',
        converted: { amountMinor: 30000, currency: 'RSD' },
        unconverted: [{ amountMinor: 1000, currency: 'EUR' }],
        lastOn: '2026-09-29',
      },
      {
        name: 'отпуск',
        converted: { amountMinor: 30000, currency: 'RSD' },
        unconverted: [],
        lastOn: '2026-09-28',
      },
    ]);
  });

  it('orders by the latest use: the day, then the instant', () => {
    const totals = summarizeTags(
      [
        item(100, 'RSD', '2026-09-28', ['б'], '2026-09-28T09:00:00Z'),
        item(100, 'RSD', '2026-09-28', ['а'], '2026-09-28T11:00:00Z'),
        item(100, 'RSD', '2026-09-27', ['в']),
      ],
      'RSD',
      rateOf,
    );

    expect(totals.map((t) => t.name)).toEqual(['а', 'б', 'в']);
  });

  it('is empty when no expense carries a tag', () => {
    expect(summarizeTags([item(100, 'RSD', '2026-09-28', [])], 'RSD', rateOf)).toEqual([]);
  });
});

describe('tagHash / findTagByHash', () => {
  it('is the first 8 hex digits of the SHA-256 of the UTF-8 name', () => {
    // sha256('abc') = ba7816bf…
    expect(tagHash(tag('abc'))).toBe('ba7816bf');
    expect(tagHash(tag('я'.repeat(32)))).toMatch(/^[0-9a-f]{8}$/);
  });

  it('finds the first name with the hash, and nothing for an unknown one', () => {
    const names = [tag('рим'), tag('отпуск')];
    expect(findTagByHash(names, tagHash(tag('отпуск')))).toBe('отпуск');
    expect(findTagByHash(names, tagHash(tag('ремонт')))).toBeUndefined();
  });
});

describe('summarizeTag', () => {
  const cafe = { id: 1, name: 'Кафе и рестораны' };
  const transport = { id: 2, name: 'Транспорт' };

  it('totals 1 914.04 RSD over 2 expenses, Транспорт 1 464.04 before Кафе 450.00', () => {
    const report = summarizeTag(
      [
        { ...item(45000, 'RSD', '2026-09-30', ['отпуск']), category: cafe },
        { ...item(1250, 'EUR', '2026-09-30', ['отпуск']), category: transport },
        { ...item(99900, 'RSD', '2026-09-30', ['рим']), category: cafe },
      ],
      tag('отпуск'),
      'RSD',
      rateOf,
    );

    expect(report).toEqual({
      name: 'отпуск',
      converted: {
        currency: 'RSD',
        totalMinor: 191404,
        lines: [
          { categoryId: 2, name: 'Транспорт', amountMinor: 146404 },
          { categoryId: 1, name: 'Кафе и рестораны', amountMinor: 45000 },
        ],
      },
      convertedFrom: [{ amountMinor: 1250, currency: 'EUR' }],
      unconverted: [],
      count: 2,
      firstOn: '2026-09-30',
      lastOn: '2026-09-30',
    });
  });

  it('spans the first and last occurred_on, whatever the order', () => {
    const report = summarizeTag(
      [
        item(100, 'RSD', '2026-09-30', ['отпуск']),
        item(100, 'RSD', '2026-09-28', ['отпуск']),
        item(100, 'RSD', '2026-09-29', ['отпуск']),
      ],
      tag('отпуск'),
      'RSD',
      rateOf,
    );

    expect(report).toMatchObject({ count: 3, firstOn: '2026-09-28', lastOn: '2026-09-30' });
  });

  it('is undefined for a tag no expense carries', () => {
    expect(
      summarizeTag([item(100, 'RSD', '2026-09-30', ['рим'])], tag('отпуск'), 'RSD', rateOf),
    ).toBeUndefined();
  });
});
