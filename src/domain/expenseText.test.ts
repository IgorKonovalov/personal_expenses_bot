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
    expect(parseExpenseText(text, 'RSD')).toEqual({ kind: 'expense', ...expected, tags: [] });
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
      tags: [],
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
  const taxi = {
    kind: 'expense',
    amountMinor: 45000,
    currency: 'RSD',
    description: 'такси',
    tags: [],
  };

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

describe('parseExpenseText: a /N split word', () => {
  const today = '2026-10-02' as LocalDate;

  it('reads /3 as a split and drops it from the description, before a date word too', () => {
    expect(parseExpenseText('1000 кафе /3', 'RSD', today)).toEqual({
      kind: 'expense',
      amountMinor: 100000,
      currency: 'RSD',
      description: 'кафе',
      split: 3,
      tags: [],
    });
    expect(parseExpenseText('1000 кафе /3 вчера', 'RSD', today)).toEqual({
      kind: 'expense',
      amountMinor: 100000,
      currency: 'RSD',
      description: 'кафе',
      date: '2026-10-01',
      split: 3,
      tags: [],
    });
  });

  it('refuses /1, /21 and two split words', () => {
    for (const text of ['1000 кафе /1', '1000 кафе /21', '1000 кафе /3 /2']) {
      expect(parseExpenseText(text, 'RSD', today), text).toEqual({ kind: 'invalid' });
    }
  });
});

describe('parseExpenseText: #tag words (ADR-0029)', () => {
  const today = '2026-10-01' as LocalDate;
  const parse = (text: string) => parseExpenseText(text, 'RSD', today);

  it('takes the tags out of the description before the date word is read', () => {
    expect(parse('450 такси #Отпуск #рим вчера')).toStrictEqual({
      kind: 'expense',
      amountMinor: 45000,
      currency: 'RSD',
      description: 'такси',
      date: '2026-09-30',
      tags: ['отпуск', 'рим'],
    });
  });

  it('keeps each normalized name once, in first-seen order', () => {
    expect(parse('450 кофе #отпуск #ОТПУСК')).toMatchObject({
      kind: 'expense',
      description: 'кофе',
      tags: ['отпуск'],
    });
    expect(parse('450 #рим кофе #отпуск #Рим')).toMatchObject({
      description: 'кофе',
      tags: ['рим', 'отпуск'],
    });
  });

  it('composes a decomposed letter before matching', () => {
    expect(parse('450 кофе #йод')).toMatchObject({ tags: ['йод'] });
  });

  it.each([
    ['450 кофе#отпуск', 'кофе#отпуск'],
    ['450 кофе #', 'кофе #'],
    ['450 кофе #a-b', 'кофе #a-b'],
    [`450 кофе #${'я'.repeat(33)}`, `кофе #${'я'.repeat(33)}`],
  ])('%j has no tags: the description is %j', (text, description) => {
    expect(parse(text)).toMatchObject({ kind: 'expense', description, tags: [] });
  });

  it('takes a 32-letter Cyrillic tag', () => {
    expect(parse(`450 кофе #${'я'.repeat(32)}`)).toMatchObject({ tags: ['я'.repeat(32)] });
  });

  it('is invalid when only tags follow the amount', () => {
    expect(parse('450 #отпуск')).toStrictEqual({ kind: 'invalid' });
    expect(parse('450 EUR #отпуск вчера')).toStrictEqual({ kind: 'invalid' });
  });

  it('refuses more than 5 distinct tags, and takes 5', () => {
    expect(parse('450 кофе #a #b #c #d #e #f')).toStrictEqual({ kind: 'tooManyTags' });
    expect(parse('450 кофе #a #b #c #d #e #A')).toMatchObject({
      kind: 'expense',
      tags: ['a', 'b', 'c', 'd', 'e'],
    });
  });

  it('carries the tags on an ambiguous amount', () => {
    expect(parse('1.200 обед #рим')).toMatchObject({
      kind: 'ambiguous',
      description: 'обед',
      tags: ['рим'],
    });
  });
});
