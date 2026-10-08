import { describe, expect, it } from 'vitest';
import { CURRENCY_ALIASES, CURRENCY_CODES, currencyOfWord } from './currencies.js';

describe('currencyOfWord', () => {
  it.each([
    ['EUR', 'EUR'],
    ['eur', 'EUR'],
    ['€', 'EUR'],
    ['Евро', 'EUR'],
    ['$', 'USD'],
    ['долларов', 'USD'],
    ['дин', 'RSD'],
    ['динар', 'RSD'],
    ['DIN', 'RSD'],
    ['руб.', 'RUB'],
    ['грн', 'UAH'],
    ['лари', 'GEL'],
  ])('reads the word %j as %s', (word, code) => {
    expect(currencyOfWord(word)).toBe(code);
  });

  it.each(['р', 'р.', 'XYZ', 'кофе', 'к'])('reads no currency in the word %j', (word) => {
    expect(currencyOfWord(word)).toBeUndefined();
  });

  it('reads a glued-only alias and refuses a word-only alias and an ISO code glued', () => {
    expect(currencyOfWord('р', 'glued')).toBe('RUB');
    expect(currencyOfWord('€', 'glued')).toBe('EUR');
    expect(currencyOfWord('евро', 'glued')).toBeUndefined();
    expect(currencyOfWord('EUR', 'glued')).toBeUndefined();
  });

  it('maps every alias to a code in the table, each alias once and lower-cased', () => {
    const aliases = CURRENCY_ALIASES.map(({ alias }) => alias);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const { alias, code } of CURRENCY_ALIASES) {
      expect(CURRENCY_CODES).toContain(code);
      expect(alias).toBe(alias.toLowerCase());
    }
  });
});
