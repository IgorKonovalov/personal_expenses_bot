import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../time.js';
import {
  exportSpan,
  expensesTable,
  itemsTable,
  type ExpenseLabels,
  type ExportExpense,
  type ItemLabels,
} from './rows.js';

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

const LABELS: ExpenseLabels = {
  date: 'Дата',
  time: 'Время',
  amount: 'Сумма',
  currency: 'Валюта',
  converted: 'Сумма в RSD',
  category: 'Категория',
  description: 'Описание',
  author: 'Автор',
  shop: 'Магазин',
  receipt: 'Чек',
  id: 'ID',
  unnamedAuthor: 'участник',
};

const COFFEE: ExportExpense = {
  id: 'e1',
  occurredOn: day('2026-09-30'),
  time: '08:05',
  amount: { amountMinor: 45000, currency: 'RSD' },
  converted: { amountMinor: 45000, currency: 'RSD' },
  category: 'Кафе',
  description: 'кофе',
  author: 'Анна',
  shop: 'Test Market',
  receiptUrl: 'https://suf.example/v?vl=x',
};

const TAXI: ExportExpense = {
  id: 'e2',
  occurredOn: day('2026-09-30'),
  time: '23:40',
  amount: { amountMinor: 1250, currency: 'EUR' },
  converted: undefined,
  category: null,
  description: 'такси',
  author: null,
  shop: null,
  receiptUrl: null,
};

describe('expensesTable', () => {
  it('puts every column in order, with empty cells for no rate, category or receipt', () => {
    const table = expensesTable('Расходы', LABELS, [COFFEE, TAXI], false);

    expect(table.columns.map((c) => c.header)).toEqual([
      'Дата',
      'Время',
      'Сумма',
      'Валюта',
      'Сумма в RSD',
      'Категория',
      'Описание',
      'Магазин',
      'Чек',
      'ID',
    ]);
    expect(table.rows).toEqual([
      [
        { kind: 'text', value: '2026-09-30' },
        { kind: 'text', value: '08:05' },
        { kind: 'amount', minor: 45000, currency: 'RSD' },
        { kind: 'text', value: 'RSD' },
        { kind: 'amount', minor: 45000, currency: 'RSD' },
        { kind: 'text', value: 'Кафе' },
        { kind: 'text', value: 'кофе' },
        { kind: 'text', value: 'Test Market' },
        { kind: 'text', value: 'https://suf.example/v?vl=x' },
        { kind: 'text', value: 'e1' },
      ],
      [
        { kind: 'text', value: '2026-09-30' },
        { kind: 'text', value: '23:40' },
        { kind: 'amount', minor: 1250, currency: 'EUR' },
        { kind: 'text', value: 'EUR' },
        { kind: 'empty' },
        { kind: 'empty' },
        { kind: 'text', value: 'такси' },
        { kind: 'empty' },
        { kind: 'empty' },
        { kind: 'text', value: 'e2' },
      ],
    ]);
  });

  it('adds Автор after Описание for a shared ledger, «участник» for a member with no name', () => {
    const table = expensesTable('Расходы', LABELS, [COFFEE, TAXI], true);

    expect(table.columns.map((c) => c.header).slice(6, 8)).toEqual(['Описание', 'Автор']);
    expect(table.rows.map((row) => row[7])).toEqual([
      { kind: 'text', value: 'Анна' },
      { kind: 'text', value: 'участник' },
    ]);
  });
});

const ITEM_LABELS: ItemLabels = {
  expenseId: 'ID расхода',
  date: 'Дата',
  shop: 'Магазин',
  position: '№',
  name: 'Наименование',
  quantity: 'Количество',
  amount: 'Сумма',
  currency: 'Валюта',
};

describe('itemsTable', () => {
  it('writes one row per item with a decimal-comma quantity', () => {
    const table = itemsTable('Позиции чеков', ITEM_LABELS, [
      {
        expenseId: 'e1',
        occurredOn: day('2026-09-30'),
        shop: 'Test Market',
        position: 2,
        name: 'Хлеб',
        quantity: '0.535',
        total: { amountMinor: 7999, currency: 'RSD' },
      },
    ]);

    expect(table.columns.map((c) => c.header)).toEqual([
      'ID расхода',
      'Дата',
      'Магазин',
      '№',
      'Наименование',
      'Количество',
      'Сумма',
      'Валюта',
    ]);
    expect(table.rows).toEqual([
      [
        { kind: 'text', value: 'e1' },
        { kind: 'text', value: '2026-09-30' },
        { kind: 'text', value: 'Test Market' },
        { kind: 'text', value: '2' },
        { kind: 'text', value: 'Хлеб' },
        { kind: 'text', value: '0,535' },
        { kind: 'amount', minor: 7999, currency: 'RSD' },
        { kind: 'text', value: 'RSD' },
      ],
    ]);
  });
});
