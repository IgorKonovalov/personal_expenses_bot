import { describe, expect, it } from 'vitest';
import { dayOfPeriod } from './budget.js';
import {
  budgetPeriodOf,
  monthOf,
  next,
  parsePeriod,
  periodKey,
  previous,
  weekOf,
} from './periods.js';
import type { LocalDate } from './time.js';

const d = (date: string) => date as LocalDate;

describe('budgetPeriodOf (ADR-0017)', () => {
  it.each([
    [1, '2026-10-05', '2026-10-01', '2026-10-31', 31],
    [10, '2026-10-05', '2026-09-10', '2026-10-09', 30],
    [10, '2026-10-10', '2026-10-10', '2026-11-09', 31],
    [31, '2027-02-15', '2027-01-31', '2027-02-27', 28],
    [31, '2027-02-28', '2027-02-28', '2027-03-30', 31],
    [30, '2028-02-29', '2028-02-29', '2028-03-29', 30],
  ])('start %i, %s -> [%s, %s], %i days', (start, date, from, to, days) => {
    const period = budgetPeriodOf(d(date), start);
    expect([period.from, period.to]).toEqual([from, to]);
    expect(dayOfPeriod(period.from, period.to)).toBe(days);
  });

  it('is monthOf for start day 1', () => {
    const { from, to } = monthOf(d('2026-10-05'));
    expect(budgetPeriodOf(d('2026-10-05'), 1)).toEqual({ from, to });
  });

  it('crosses a year end with start 15', () => {
    expect(budgetPeriodOf(d('2027-01-03'), 15)).toEqual({ from: '2026-12-15', to: '2027-01-14' });
  });
});

describe('weekOf', () => {
  it('runs Monday to Sunday', () => {
    expect(weekOf(d('2026-09-30'))).toEqual({ kind: 'week', from: '2026-09-28', to: '2026-10-04' });
    expect(weekOf(d('2026-09-27'))).toEqual({ kind: 'week', from: '2026-09-21', to: '2026-09-27' });
    expect(weekOf(d('2026-09-28'))).toEqual({ kind: 'week', from: '2026-09-28', to: '2026-10-04' });
  });

  it('spans a year boundary', () => {
    expect(weekOf(d('2027-01-01'))).toEqual({ kind: 'week', from: '2026-12-28', to: '2027-01-03' });
  });
});

describe('monthOf', () => {
  it('runs from the 1st to the last day', () => {
    expect(monthOf(d('2026-09-30'))).toEqual({
      kind: 'month',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(monthOf(d('2024-02-10')).to).toBe('2024-02-29');
    expect(monthOf(d('2026-02-10')).to).toBe('2026-02-28');
    expect(monthOf(d('2026-12-31'))).toEqual({
      kind: 'month',
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('previous and next', () => {
  it('step a month across a year', () => {
    expect(previous(monthOf(d('2026-01-15'))).from).toBe('2025-12-01');
    expect(next(monthOf(d('2026-12-15'))).from).toBe('2027-01-01');
    expect(previous(monthOf(d('2026-09-30'))).to).toBe('2026-08-31');
  });

  it('step a week by seven days', () => {
    expect(previous(weekOf(d('2026-09-30')))).toEqual(weekOf(d('2026-09-21')));
    expect(next(weekOf(d('2026-09-27')))).toEqual(weekOf(d('2026-09-28')));
  });
});

describe('parsePeriod', () => {
  it('reads back periodKey', () => {
    const month = monthOf(d('2026-09-30'));
    const week = weekOf(d('2026-09-30'));
    expect(periodKey(month)).toBe('2026-09');
    expect(periodKey(week)).toBe('2026-09-28');
    expect(parsePeriod('month', '2026-09')).toEqual(month);
    expect(parsePeriod('week', '2026-09-28')).toEqual(week);
  });

  it.each([
    ['month', '2026-13'],
    ['month', '2026-00'],
    ['month', '2026-9'],
    ['month', '2026-09-01'],
    ['week', '2026-09-29'],
    ['week', '2026-02-30'],
    ['week', '2026-09'],
  ] as const)('refuses %s %j', (kind, key) => {
    expect(parsePeriod(kind, key)).toBeUndefined();
  });
});
