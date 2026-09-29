import { describe, expect, it } from 'vitest';
import { formatMoney, parseAmount } from './money.js';

describe('parseAmount (RSD, exponent 2)', () => {
  it.each([
    ['450', 45000],
    ['12,50', 1250],
    ['12.50', 1250],
    ['12.5', 1250],
    ['12,5', 1250],
    ['0.50', 50],
    ['1 200', 120000],
    ['1 200', 120000],
    ['1 200', 120000],
    ['1 200', 120000],
    ['12 345 678', 1234567800],
    ['1200', 120000],
  ])('%j -> %i minor units', (token, amountMinor) => {
    expect(parseAmount(token, 'RSD')).toEqual({ kind: 'ok', amountMinor });
  });

  it.each(['1,200', '1.200'])('%j is ambiguous between thousands and decimal', (token) => {
    expect(parseAmount(token, 'RSD')).toEqual({
      kind: 'ambiguous',
      readings: [
        { interpretation: 'thousands', amountMinor: 120000 },
        { interpretation: 'decimal', amountMinor: 120 },
      ],
    });
  });

  it.each([
    ['1.234', 123400],
    ['12,505', 1250500],
  ])('%j lists only the thousands reading (decimal needs 3 digits)', (token, amountMinor) => {
    expect(parseAmount(token, 'RSD')).toEqual({
      kind: 'ambiguous',
      readings: [{ interpretation: 'thousands', amountMinor }],
    });
  });

  it.each([
    '1.200,50',
    '12.5055',
    '0',
    '0.00',
    '-5',
    '1 20',
    '1 2000',
    '1  200',
    '12.',
    '.50',
    'abc',
    '',
    '9999999999999999',
  ])('%j is a parse failure', (token) => {
    expect(parseAmount(token, 'RSD')).toEqual({ kind: 'invalid' });
  });
});

describe('parseAmount uses the currency exponent', () => {
  it('JPY (exponent 0): 450 -> 450, 12.5 fails', () => {
    expect(parseAmount('450', 'JPY')).toEqual({ kind: 'ok', amountMinor: 450 });
    expect(parseAmount('12.5', 'JPY')).toEqual({ kind: 'invalid' });
  });
});

describe('formatMoney', () => {
  it.each([
    [46250, 'RSD', '462.50 RSD'],
    [120000, 'RSD', '1 200.00 RSD'],
    [1250, 'EUR', '12.50 EUR'],
    [5, 'EUR', '0.05 EUR'],
    [1234567800, 'RSD', '12 345 678.00 RSD'],
    [450, 'JPY', '450 JPY'],
  ] as const)('%i %s -> %j', (amountMinor, currency, expected) => {
    expect(formatMoney({ amountMinor, currency })).toBe(expected);
  });
});
