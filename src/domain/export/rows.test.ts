import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../time.js';
import { exportSpan, expensesTable, type ExpenseHeaders } from './rows.js';

const day = (value: string) => value as LocalDate;

describe('exportSpan', () => {
  it('covers 1 October alone for this month on 1 October, and all of September for last month', () => {
    expect(exportSpan('tm', day('2026-10-01'))).toEqual({
      key: '2026-10',
      dates: { from: '2026-10-01', to: '2026-10-01' },
    });
    expect(exportSpan('pm', day('2026-10-01'))).toEqual({
      key: '2026-09',
      dates: { from: '2026-09-01', to: '2026-09-30' },
    });
  });

  it('takes last month across a year end, and this year from 1 January', () => {
    expect(exportSpan('pm', day('2026-01-15'))).toEqual({
      key: '2025-12',
      dates: { from: '2025-12-01', to: '2025-12-31' },
    });
    expect(exportSpan('ty', day('2026-10-02'))).toEqual({
      key: '2026',
      dates: { from: '2026-01-01', to: '2026-10-02' },
    });
  });

  it('has no dates for all time', () => {
    expect(exportSpan('all', day('2026-10-02'))).toEqual({ key: 'all' });
  });
});

const HEADERS: ExpenseHeaders = {
  date: 'Дата',
  amount: 'Сумма',
  currency: 'Валюта',
  category: 'Категория',
  description: 'Описание',
};

describe('expensesTable', () => {
  it('puts date, amount, currency, category and description in that order', () => {
    const table = expensesTable('Расходы', HEADERS, [
      {
        id: 'e1',
        occurredOn: day('2026-09-30'),
        amount: { amountMinor: 45000, currency: 'RSD' },
        category: 'Кафе',
        description: 'кофе',
      },
      {
        id: 'e2',
        occurredOn: day('2026-09-30'),
        amount: { amountMinor: 1250, currency: 'EUR' },
        category: null,
        description: 'такси',
      },
    ]);

    expect(table.columns.map((c) => c.header)).toEqual([
      'Дата',
      'Сумма',
      'Валюта',
      'Категория',
      'Описание',
    ]);
    expect(table.rows).toEqual([
      [
        { kind: 'text', value: '2026-09-30' },
        { kind: 'amount', minor: 45000, currency: 'RSD' },
        { kind: 'text', value: 'RSD' },
        { kind: 'text', value: 'Кафе' },
        { kind: 'text', value: 'кофе' },
      ],
      [
        { kind: 'text', value: '2026-09-30' },
        { kind: 'amount', minor: 1250, currency: 'EUR' },
        { kind: 'text', value: 'EUR' },
        { kind: 'empty' },
        { kind: 'text', value: 'такси' },
      ],
    ]);
  });
});
