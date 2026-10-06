import { describe, expect, it } from 'vitest';
import {
  debtBalances,
  parseDebtAmount,
  parsePersonName,
  signedAmount,
  sortDebtLines,
} from './debts.js';

describe('signedAmount', () => {
  it('counts lend and i_repaid up, borrow and repaid_to_me down', () => {
    expect(signedAmount('lend', 500)).toBe(500);
    expect(signedAmount('i_repaid', 500)).toBe(500);
    expect(signedAmount('borrow', 500)).toBe(-500);
    expect(signedAmount('repaid_to_me', 500)).toBe(-500);
  });
});

describe('debtBalances', () => {
  it('sums per person and per currency, never across currencies', () => {
    expect(
      debtBalances([
        { personId: 1, kind: 'lend', amountMinor: 500000, currency: 'RSD' },
        { personId: 1, kind: 'lend', amountMinor: 2000, currency: 'EUR' },
        { personId: 2, kind: 'borrow', amountMinor: 2000, currency: 'EUR' },
      ]),
    ).toEqual([
      { personId: 1, currency: 'RSD', amountMinor: 500000 },
      { personId: 1, currency: 'EUR', amountMinor: 2000 },
      { personId: 2, currency: 'EUR', amountMinor: -2000 },
    ]);
  });

  it('drops a balance that sums to zero', () => {
    expect(
      debtBalances([
        { personId: 1, kind: 'lend', amountMinor: 500000, currency: 'RSD' },
        { personId: 1, kind: 'repaid_to_me', amountMinor: 200000, currency: 'RSD' },
        { personId: 1, kind: 'repaid_to_me', amountMinor: 300000, currency: 'RSD' },
      ]),
    ).toEqual([]);
  });
});

describe('sortDebtLines', () => {
  it('puts people who owe me first, then people I owe, each by name', () => {
    const line = (name: string, amountMinor: number) => ({
      name,
      amountMinor,
      currency: 'RSD' as const,
    });
    expect(
      sortDebtLines([line('Аня', -100), line('Петя', 100), line('Борис', 100), line('Вера', -5)]),
    ).toEqual([line('Борис', 100), line('Петя', 100), line('Аня', -100), line('Вера', -5)]);
  });
});

describe('parsePersonName', () => {
  it('trims, keeps the case, and keys on the lower-cased name', () => {
    expect(parsePersonName('  Петя ')).toEqual({ kind: 'valid', name: 'Петя', key: 'петя' });
    expect(parsePersonName('петя')).toEqual({ kind: 'valid', name: 'петя', key: 'петя' });
  });

  it('accepts 1 to 40 characters and refuses the rest', () => {
    expect(parsePersonName('   ')).toEqual({ kind: 'invalid', reason: 'empty' });
    expect(parsePersonName('я'.repeat(40)).kind).toBe('valid');
    expect(parsePersonName('я'.repeat(41))).toEqual({ kind: 'invalid', reason: 'tooLong' });
  });
});

describe('parseDebtAmount', () => {
  it('reads an amount in the default currency, or in a named one', () => {
    expect(parseDebtAmount('5000', 'RSD')).toEqual({
      kind: 'ok',
      amountMinor: 500000,
      currency: 'RSD',
    });
    expect(parseDebtAmount('20 EUR', 'RSD')).toEqual({
      kind: 'ok',
      amountMinor: 2000,
      currency: 'EUR',
    });
    expect(parseDebtAmount('12,50 eur', 'RSD')).toEqual({
      kind: 'ok',
      amountMinor: 1250,
      currency: 'EUR',
    });
  });

  it('refuses text, zero and an amount that reads two ways', () => {
    expect(parseDebtAmount('Петя', 'RSD')).toEqual({ kind: 'invalid' });
    expect(parseDebtAmount('0', 'RSD')).toEqual({ kind: 'invalid' });
    expect(parseDebtAmount('1.200', 'RSD')).toEqual({ kind: 'invalid' });
  });
});
