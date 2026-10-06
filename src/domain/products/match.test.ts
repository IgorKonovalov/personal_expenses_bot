import { describe, expect, it } from 'vitest';
import { CATALOG } from './catalog.js';
import { matchProduct } from './match.js';
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
