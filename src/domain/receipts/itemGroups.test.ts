import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from '../currencies.js';
import type { LocalDate } from '../time.js';
import { groupItems, type PeriodItem } from './itemGroups.js';

const RSD = 'RSD' as CurrencyCode;
const EUR = 'EUR' as CurrencyCode;

function item(
  name: string,
  totalMinor: number,
  occurredOn: string,
  category: readonly [number, string] | null,
  extra: Partial<PeriodItem> = {},
): PeriodItem {
  return {
    name,
    quantity: '1',
    totalMinor,
    currency: RSD,
    occurredOn: occurredOn as LocalDate,
    categoryId: category === null ? null : category[0],
    categoryName: category === null ? null : category[1],
    receiptKey: `r-${occurredOn}-${name}`,
    position: 1,
    ...extra,
  };
}

const FOOD = [1, 'Еда'] as const;
const HOME = [2, 'Дом'] as const;
const TRANSPORT = [3, 'Транспорт'] as const;

describe('groupItems', () => {
  it('orders categories by default-currency total and items by name, then date', () => {
    const groups = groupItems(
      [
        item('Хлеб', 7999, '2026-10-05', FOOD, { receiptKey: 'a', position: 1 }),
        item('Молоко', 14900, '2026-10-05', FOOD, { receiptKey: 'a', position: 2 }),
        item('хлеб', 8499, '2026-10-06', FOOD, { receiptKey: 'b' }),
        item('Средство', 39900, '2026-10-06', HOME),
        item('Кофе', 30000, '2026-10-07', FOOD),
      ],
      RSD,
    );

    expect(groups.map((g) => [g.categoryName, g.totals])).toEqual([
      ['Еда', [{ currency: RSD, amountMinor: 61398 }]],
      ['Дом', [{ currency: RSD, amountMinor: 39900 }]],
    ]);
    expect(groups[0]?.items.map((i) => [i.name, i.occurredOn])).toEqual([
      ['Кофе', '2026-10-07'],
      ['Молоко', '2026-10-05'],
      ['Хлеб', '2026-10-05'],
      ['хлеб', '2026-10-06'],
    ]);
  });

  it('breaks a name and date tie by receipt, then position', () => {
    const [group] = groupItems(
      [
        item('Хлеб', 100, '2026-10-05', FOOD, { receiptKey: 'b', position: 1 }),
        item('Хлеб', 200, '2026-10-05', FOOD, { receiptKey: 'a', position: 3 }),
        item('Хлеб', 300, '2026-10-05', FOOD, { receiptKey: 'a', position: 2 }),
      ],
      RSD,
    );

    expect(group?.items.map((i) => i.totalMinor)).toEqual([300, 200, 100]);
  });

  it('sums per currency, the default first, and puts a group without it after, by name', () => {
    const groups = groupItems(
      [
        item('Билет', 1250, '2026-10-05', TRANSPORT, { currency: EUR }),
        item('Сыр', 500, '2026-10-05', null, { currency: EUR }),
        item('Вода', 300, '2026-10-05', FOOD, { currency: EUR }),
        item('Хлеб', 100, '2026-10-05', FOOD),
        item('Ложка', 50, '2026-10-05', HOME, { currency: EUR }),
      ],
      RSD,
    );

    expect(groups.map((g) => [g.categoryName, g.totals])).toEqual([
      [
        'Еда',
        [
          { currency: RSD, amountMinor: 100 },
          { currency: EUR, amountMinor: 300 },
        ],
      ],
      ['Дом', [{ currency: EUR, amountMinor: 50 }]],
      ['Транспорт', [{ currency: EUR, amountMinor: 1250 }]],
      [null, [{ currency: EUR, amountMinor: 500 }]],
    ]);
  });

  it('returns no groups for no items', () => {
    expect(groupItems([], RSD)).toEqual([]);
  });
});
