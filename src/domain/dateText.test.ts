import { describe, expect, it } from 'vitest';
import { addDays, parseDateSuffix } from './dateText.js';
import type { LocalDate } from './time.js';

const TODAY = '2026-09-29' as LocalDate;

describe('parseDateSuffix (today 2026-09-29)', () => {
  it.each([
    ['вчера', '2026-09-28'],
    ['Вчера', '2026-09-28'],
    ['позавчера', '2026-09-27'],
    ['Позавчера', '2026-09-27'],
    ['25.09', '2026-09-25'],
    ['5.09', '2026-09-05'],
    ['29.09', '2026-09-29'],
    ['05.10', '2025-10-05'],
    ['25.09.2025', '2025-09-25'],
    ['29.09.2026', '2026-09-29'],
  ])('%j -> %s', (word, date) => {
    expect(parseDateSuffix(word, TODAY)).toEqual({ kind: 'date', date });
  });

  it('refuses a literal date after today', () => {
    expect(parseDateSuffix('05.10.2026', TODAY)).toEqual({ kind: 'future', date: '2026-10-05' });
    expect(parseDateSuffix('30.09.2026', TODAY)).toEqual({ kind: 'future', date: '2026-09-30' });
  });

  it.each(['31.02', '31.02.2026', '1.5', '00.09', '5.13', '105.09', 'такси', '25.9', '25.09.26'])(
    '%j is not a date',
    (word) => {
      expect(parseDateSuffix(word, TODAY)).toEqual({ kind: 'none' });
    },
  );

  it('infers last year across New Year: 30.12 on 2027-01-02 is 2026-12-30', () => {
    expect(parseDateSuffix('30.12', '2027-01-02' as LocalDate)).toEqual({
      kind: 'date',
      date: '2026-12-30',
    });
  });

  it('resolves 29.02 to the most recent leap day', () => {
    expect(parseDateSuffix('29.02', TODAY)).toEqual({ kind: 'date', date: '2024-02-29' });
  });

  it('counts вчера back across a month and a year boundary', () => {
    expect(parseDateSuffix('вчера', '2026-03-01' as LocalDate)).toEqual({
      kind: 'date',
      date: '2026-02-28',
    });
    expect(parseDateSuffix('позавчера', '2027-01-01' as LocalDate)).toEqual({
      kind: 'date',
      date: '2026-12-30',
    });
  });
});

describe('addDays', () => {
  it('steps over month ends and leap days', () => {
    expect(addDays('2024-02-28' as LocalDate, 1)).toBe('2024-02-29');
    expect(addDays('2026-10-01' as LocalDate, -1)).toBe('2026-09-30');
    expect(addDays('2026-09-28' as LocalDate, 6)).toBe('2026-10-04');
  });
});
