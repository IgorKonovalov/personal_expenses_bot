import { describe, expect, it } from 'vitest';
import { readExpenseLines } from './expenseLines.js';
import type { LocalDate } from './time.js';

const TODAY = '2026-10-08' as LocalDate;
const read = (text: string) => readExpenseLines(text, 'RSD', TODAY);

const expense = (amountMinor: number, currency: string, description: string, date?: string) => ({
  kind: 'expense',
  amountMinor,
  currency,
  description,
  ...(date === undefined ? {} : { date }),
  tags: [],
});

describe('readExpenseLines (ADR-0049)', () => {
  it('reads one line as single', () => {
    expect(read('450 кофе')).toEqual({ kind: 'single' });
  });

  it('reads one expense line and a prose line as single', () => {
    expect(read('450 кофе\nс Ирой')).toEqual({ kind: 'single' });
  });

  it('reads three expense lines, each in its own currency', () => {
    expect(read('450 кофе\n1200 такси\n12 eur обед')).toEqual({
      kind: 'lines',
      lines: [
        expense(45000, 'RSD', 'кофе'),
        expense(120000, 'RSD', 'такси'),
        expense(1200, 'EUR', 'обед'),
      ],
    });
  });

  it('reads amount-last lines and drops the blank line', () => {
    expect(read('кофе 450\n\nтакси 1200')).toEqual({
      kind: 'lines',
      lines: [expense(45000, 'RSD', 'кофе'), expense(120000, 'RSD', 'такси')],
    });
  });

  it('dates a line by its own date word', () => {
    expect(read('450 кофе\n1200 такси вчера')).toEqual({
      kind: 'lines',
      lines: [expense(45000, 'RSD', 'кофе'), expense(120000, 'RSD', 'такси', '2026-10-07')],
    });
  });

  it.each([
    ['450 кофе\nс Ирой\n1200 такси', 2, 'с Ирой', 'unreadable'],
    ['450 кофе\n1.500 лампа', 2, '1.500 лампа', 'ambiguous'],
    ['450 кофе\n1200 такси 25.12.2026', 2, '1200 такси 25.12.2026', 'future'],
    ['450 кофе\n3000 ужин /3', 2, '3000 ужин /3', 'split'],
  ])('refuses %j at line %i (%s, %s)', (text, n, line, reason) => {
    expect(read(text)).toEqual({ kind: 'badLine', n, line, reason });
  });

  // A bare `dd.mm` is the most recent such date not after today (parseDateSuffix), never future.
  it('dates `25.12` on 8 October 2026 to the last 25 December', () => {
    expect(read('450 кофе\n1200 такси 25.12')).toEqual({
      kind: 'lines',
      lines: [expense(45000, 'RSD', 'кофе'), expense(120000, 'RSD', 'такси', '2025-12-25')],
    });
  });

  it('refuses too many tags on a line', () => {
    expect(read('450 кофе\n100 хлеб #a #b #c #d #e #f #g #h #i #j #k\n1200 такси')).toMatchObject({
      kind: 'badLine',
      n: 2,
      reason: 'tooManyTags',
    });
  });

  it('refuses 21 lines as tooMany, and records 20', () => {
    expect(read(Array.from({ length: 21 }, () => '100 хлеб').join('\n'))).toEqual({
      kind: 'tooMany',
    });
    expect(read(Array.from({ length: 20 }, () => '100 хлеб').join('\n'))).toMatchObject({
      kind: 'lines',
    });
  });
});
