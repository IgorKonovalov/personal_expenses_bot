import { describe, expect, it } from 'vitest';
import { pickTip, TIPS, type TipContext } from './tips.js';

const FOREIGN_OTHER: TipContext = {
  ledgerCurrency: 'RSD',
  expense: { currency: 'EUR', fallbackCategory: true },
};

describe('pickTip', () => {
  it('walks the recording tips in priority order as each is seen', () => {
    const seen = new Set<string>();
    expect(pickTip(TIPS, 'expenseRecorded', FOREIGN_OTHER, seen)).toBe('tipOther');
    seen.add('tipOther');
    expect(pickTip(TIPS, 'expenseRecorded', FOREIGN_OTHER, seen)).toBe('tipForeign');
    seen.add('tipForeign');
    expect(pickTip(TIPS, 'expenseRecorded', FOREIGN_OTHER, seen)).toBe('tipFirstExpense');
    seen.add('tipFirstExpense');
    expect(pickTip(TIPS, 'expenseRecorded', FOREIGN_OTHER, seen)).toBeUndefined();
  });

  it('skips a tip whose condition fails', () => {
    const plain: TipContext = {
      ledgerCurrency: 'RSD',
      expense: { currency: 'RSD', fallbackCategory: false },
    };
    expect(pickTip(TIPS, 'expenseRecorded', plain, new Set())).toBe('tipFirstExpense');
  });

  it('picks only entries of the trigger', () => {
    expect(pickTip(TIPS, 'todayShown', { ledgerCurrency: 'RSD' }, new Set())).toBe('tipPastDate');
    expect(
      pickTip(TIPS, 'todayShown', { ledgerCurrency: 'RSD' }, new Set(['tipPastDate'])),
    ).toBeUndefined();
  });
});
