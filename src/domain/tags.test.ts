import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from './currencies.js';
import type { RateOf } from './fx.js';
import { decodeTags, encodeTags, summarizeTags, toTagName, type TagName } from './tags.js';
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
