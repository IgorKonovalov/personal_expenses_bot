import { describe, expect, it } from 'vitest';
import { CATALOG } from './catalog.js';
import { createNameMatcher, matchProduct } from './match.js';
import { normalize } from './normalize.js';

const productOf = (name: string) => matchProduct(normalize(name))?.name;

describe('matchProduct', () => {
  it('matches the fixture milks, bread and bananas', () => {
    expect(productOf('MLEKO 2,8%MM 1L IMLEK')).toBe('Молоко');
    expect(productOf('MLEKO 0,5L MOJA KRAVICA')).toBe('Молоко');
    expect(productOf('МЛЕКО 1Л')).toBe('Молоко');
    expect(productOf('MLEKO IMLEK')).toBe('Молоко');
    expect(productOf('HLEB BELI 500G')).toBe('Хлеб');
    expect(productOf('BANANA /KG')).toBe('Бананы');
  });

  it('keeps chocolate milk off milk by its exclusion, and a bag off everything', () => {
    expect(matchProduct(normalize('ČOKOLADNO MLEKO 0,2L'))).toBeUndefined();
    expect(matchProduct(normalize('KESA'))).toBeUndefined();
  });

  it('matches a bare keyword as a whole word only', () => {
    expect(productOf('SIR GAUDA 300G')).toBe('Сыр');
    expect(matchProduct('sirce jabukovo 1l')).toBeUndefined();
  });

  it('prefers the keyword that starts earliest: beli luk is garlic, luk is onion', () => {
    expect(productOf('BELI LUK 100G')).toBe('Чеснок');
    expect(productOf('CRNI LUK 1KG')).toBe('Лук');
    expect(productOf('JOGURT SA MLEKOM 1L')).toBe('Йогурт');
  });

  it('keys every product with at most 24 ASCII characters, each key once', () => {
    const keys = CATALOG.map((product) => product.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9_]{1,24}$/);
  });
});

describe('createNameMatcher', () => {
  // matchProduct, counting its calls.
  function counting() {
    const counter = { calls: 0 };
    const match = (nameKey: string) => {
      counter.calls++;
      return matchProduct(nameKey);
    };
    return { counter, match };
  }

  it('matches 1,000 names drawn from 10 strings 10 times, and a second pass 0 more', () => {
    const { counter, match } = counting();
    const matcher = createNameMatcher(100, match);
    const names = Array.from({ length: 1000 }, (_, i) => `MLEKO ${i % 10} 1L`);

    for (const name of names) matcher.match(name);
    expect(counter.calls).toBe(10);

    for (const name of names) matcher.match(name);
    expect(counter.calls).toBe(10);
  });

  it('holds 3 at capacity 3 and evicts the oldest: d is a hit, a is matched again', () => {
    const { counter, match } = counting();
    const matcher = createNameMatcher(3, match);
    for (const name of ['a', 'b', 'c', 'd']) matcher.match(name);

    expect(matcher.size).toBe(3);
    expect(counter.calls).toBe(4);
    matcher.match('d');
    expect(counter.calls).toBe(4);
    matcher.match('a');
    expect(counter.calls).toBe(5);
  });

  it('answers the normalized key and the rule product, and keys two spellings apart', () => {
    const matcher = createNameMatcher(10);

    const cyrillic = matcher.match('МЛЕКО 1Л');
    const latin = matcher.match('Mleko 1l');

    expect(matcher.size).toBe(2);
    expect(cyrillic.nameKey).toBe(normalize('МЛЕКО 1Л'));
    expect(latin.nameKey).toBe(cyrillic.nameKey);
    expect(cyrillic.ruleRef).toBe('b:milk');
    expect(latin.ruleRef).toBe('b:milk');
    expect(matcher.match('KESA').ruleRef).toBeUndefined();
  });
});
