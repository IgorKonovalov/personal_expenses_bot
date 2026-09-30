import { describe, expect, it } from 'vitest';
import { parseExpenseText } from './expenseText.js';
import type { LocalDate } from './time.js';

describe('parseExpenseText (ledger default RSD)', () => {
  it.each([
    ['450 coffee', { amountMinor: 45000, currency: 'RSD', description: 'coffee' }],
    ['12.50 eur taxi', { amountMinor: 1250, currency: 'EUR', description: 'taxi' }],
    ['12.50 EUR taxi', { amountMinor: 1250, currency: 'EUR', description: 'taxi' }],
    ['12 XYZ taxi', { amountMinor: 1200, currency: 'RSD', description: 'XYZ taxi' }],
    ['1 200 new shoes', { amountMinor: 120000, currency: 'RSD', description: 'new shoes' }],
    [
      '  450   coffee  to go ',
      { amountMinor: 45000, currency: 'RSD', description: 'coffee to go' },
    ],
  ])('%j -> %j', (text, expected) => {
    expect(parseExpenseText(text, 'RSD')).toEqual({ kind: 'expense', ...expected });
  });

  it('coffee 450 is not an expense', () => {
    expect(parseExpenseText('coffee 450', 'RSD')).toEqual({ kind: 'notExpense' });
  });

  it('1.200 lunch is ambiguous and carries the currency and description', () => {
    expect(parseExpenseText('1.200 lunch', 'RSD')).toEqual({
      kind: 'ambiguous',
      readings: [
        { interpretation: 'thousands', amountMinor: 120000 },
        { interpretation: 'decimal', amountMinor: 120 },
      ],
      currency: 'RSD',
      description: 'lunch',
    });
  });

  it.each(['1.200,50 lunch', '1 20 coffee', '450coffee', '450', '450 eur', '0 coffee'])(
    '%j is an invalid expense',
    (text) => {
      expect(parseExpenseText(text, 'RSD')).toEqual({ kind: 'invalid' });
    },
  );
});

describe('parseExpenseText with a date suffix (today 2026-09-29, default RSD)', () => {
  const TODAY = '2026-09-29' as LocalDate;
  const parse = (text: string) => parseExpenseText(text, 'RSD', TODAY);
  const taxi = { kind: 'expense', amountMinor: 45000, currency: 'RSD', description: 'такси' };

  it.each([
    ['450 такси вчера', '2026-09-28'],
    ['450 такси Позавчера', '2026-09-27'],
    ['450 такси 25.09', '2026-09-25'],
    ['450 такси 5.09', '2026-09-05'],
    ['450 такси 05.10', '2025-10-05'],
    ['450 такси 29.09', '2026-09-29'],
    ['450 такси 25.09.2025', '2025-09-25'],
  ])('%j -> 45000 RSD такси on %s', (text, date) => {
    expect(parse(text)).toStrictEqual({ ...taxi, date });
  });

  it('refuses a literal future date', () => {
    expect(parse('450 такси 05.10.2026')).toStrictEqual({ kind: 'futureDate', date: '2026-10-05' });
  });

  it.each([
    ['450 такси 31.02', 'такси 31.02'],
    ['450 молоко 1.5', 'молоко 1.5'],
    ['450 вчера такси', 'вчера такси'],
  ])('%j keeps every word in the description, with no date', (text, description) => {
    expect(parse(text)).toStrictEqual({ ...taxi, description });
  });

  it.each(['450 вчера', '450 EUR вчера', '450 25.09'])('%j has no description: invalid', (text) => {
    expect(parse(text)).toStrictEqual({ kind: 'invalid' });
  });

  it('takes the currency before the description and the date after it', () => {
    expect(parse('450 EUR такси вчера')).toStrictEqual({
      ...taxi,
      currency: 'EUR',
      date: '2026-09-28',
    });
  });

  it('carries the date on an ambiguous amount', () => {
    expect(parse('1.200 обед вчера')).toMatchObject({
      kind: 'ambiguous',
      description: 'обед',
      date: '2026-09-28',
    });
  });

  it('reads no date without a today', () => {
    expect(parseExpenseText('450 такси вчера', 'RSD')).toStrictEqual({
      ...taxi,
      description: 'такси вчера',
    });
  });
});
