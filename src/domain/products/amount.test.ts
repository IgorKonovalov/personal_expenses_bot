import { describe, expect, it } from 'vitest';
import { amountOf, formatAmount, quantityMilli, unitPriceMinor } from './amount.js';
import { normalize } from './normalize.js';

const amount = (name: string, quantity: string, unit: 'l' | 'kg' | 'pcs') =>
  amountOf(normalize(name), quantity, unit);

describe('quantityMilli', () => {
  it('reads a quantity as integer thousandths, with no float', () => {
    expect(quantityMilli('2')).toBe(2000n);
    expect(quantityMilli('0.535')).toBe(535n);
    expect(quantityMilli('1,5')).toBe(1500n);
  });

  it('rejects more than three decimals and anything not a plain decimal', () => {
    expect(quantityMilli('1.2345')).toBeUndefined();
    expect(quantityMilli('-1')).toBeUndefined();
    expect(quantityMilli('1e3')).toBeUndefined();
    expect(quantityMilli('')).toBeUndefined();
  });
});

describe('amountOf', () => {
  it('multiplies the quantity by the pack size: the fixture milks in thousandths of ml', () => {
    expect(amount('MLEKO 2,8%MM 1L IMLEK', '2', 'l')).toBe(2_000_000n);
    expect(amount('MLEKO 0,5L MOJA KRAVICA', '2', 'l')).toBe(1_000_000n);
    expect(amount('МЛЕКО 1Л', '1', 'l')).toBe(1_000_000n);
    expect(amount('ČOKOLADNO MLEKO 0,2L', '1', 'l')).toBe(200_000n);
  });

  it('reads a /kg item with no size as weighed: 1.245 is 1245 g', () => {
    expect(amount('BANANA /KG', '1.245', 'kg')).toBe(1_245_000n);
    expect(amount('BANANA /KG', '0.535', 'kg')).toBe(535_000n);
  });

  it('reads ml, g, gr, kom and a multipack', () => {
    expect(amount('HLEB BELI 500G', '1', 'kg')).toBe(500_000n);
    expect(amount('KAFA 200 GR', '1', 'kg')).toBe(200_000n);
    expect(amount('SOK 330ML', '3', 'l')).toBe(990_000n);
    expect(amount('JAJA 10 KOM', '1', 'pcs')).toBe(10_000n);
    expect(amount('VODA 6X1,5L', '1', 'l')).toBe(9_000_000n);
  });

  it('has no amount without a readable size, or with a size of another dimension', () => {
    expect(amount('MLEKO IMLEK', '1', 'l')).toBeUndefined();
    expect(amount('JOGURT 180G', '1', 'l')).toBeUndefined();
    expect(amount('MLEKO 1L', '1.2345', 'l')).toBeUndefined();
    expect(amount('MLEKO /KG', '1', 'l')).toBeUndefined();
  });
});

describe('unitPriceMinor', () => {
  it('rounds total * 10^6 / amount half up: 200.00 per kg for the bananas', () => {
    expect(unitPriceMinor(24900, 1_245_000n, 'kg')).toBe(20000);
  });

  it('gives 14951 for 7999 over 0.535 kg (14951.40)', () => {
    expect(unitPriceMinor(7999, 535_000n, 'kg')).toBe(14951);
  });

  it('rounds a half up: 40600 over 2.2 l (18454.55) is 18455', () => {
    expect(unitPriceMinor(40600, 2_200_000n, 'l')).toBe(18455);
  });

  it('prices pieces per piece, and has no price for a zero amount', () => {
    expect(unitPriceMinor(36000, 10_000n, 'pcs')).toBe(3600);
    expect(unitPriceMinor(100, 0n, 'l')).toBeUndefined();
  });
});

describe('formatAmount', () => {
  it('shows l and kg to the ml or g, with no trailing zeros', () => {
    expect(formatAmount(2_000_000n, 'l')).toBe('2');
    expect(formatAmount(2_200_000n, 'l')).toBe('2.2');
    expect(formatAmount(1_245_000n, 'kg')).toBe('1.245');
    expect(formatAmount(10_000n, 'pcs')).toBe('10');
  });
});
