import { describe, expect, it } from 'vitest';
import { pickTip, TIPS, type TipContext } from './tips.js';

// A personal RSD ledger the user owns: few expenses, no budget, not sealed.
const BASE: TipContext = {
  ledgerKind: 'personal',
  ledgerCurrency: 'RSD',
  ledgerExpenseCount: 1,
  hasBudgetLimit: false,
  sealed: false,
  ownsLedger: true,
};

const FOREIGN_OTHER: TipContext = {
  ...BASE,
  expense: { currency: 'EUR', fallbackCategory: true, fromReceipt: false },
};

const PLAIN_EXPENSE = { currency: 'RSD', fallbackCategory: false, fromReceipt: false } as const;

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
    const plain: TipContext = { ...BASE, expense: PLAIN_EXPENSE };
    expect(pickTip(TIPS, 'expenseRecorded', plain, new Set())).toBe('tipFirstExpense');
  });

  it('picks only entries of the trigger', () => {
    expect(pickTip(TIPS, 'todayShown', BASE, new Set())).toBe('tipPastDate');
    expect(pickTip(TIPS, 'todayShown', BASE, new Set(['tipPastDate']))).toBeUndefined();
  });
});

describe('the feature tips', () => {
  // Every recording tip but the one under test already seen.
  const seenBut = (key: string) =>
    new Set(TIPS.filter((tip) => tip.key !== key).map((tip) => tip.key));

  it('gives tipGroup at 20 personal expenses and nothing new at 19', () => {
    const at = (count: number, ledgerKind: 'personal' | 'shared' = 'personal') =>
      pickTip(
        TIPS,
        'expenseRecorded',
        { ...BASE, ledgerKind, ledgerExpenseCount: count, expense: PLAIN_EXPENSE },
        seenBut('tipGroup'),
      );
    expect(at(20)).toBe('tipGroup');
    expect(at(19)).toBeUndefined();
    expect(at(20, 'shared')).toBeUndefined();
  });

  it('gives tipExport at 50 expenses and not at 49', () => {
    const at = (count: number) =>
      pickTip(
        TIPS,
        'expenseRecorded',
        { ...BASE, ledgerExpenseCount: count, expense: PLAIN_EXPENSE },
        seenBut('tipExport'),
      );
    expect(at(50)).toBe('tipExport');
    expect(at(49)).toBeUndefined();
  });

  it('gives tipReceipt ahead of tipFirstExpense for a receipt', () => {
    const receipt = { ...BASE, expense: { ...PLAIN_EXPENSE, fromReceipt: true } };
    expect(pickTip(TIPS, 'expenseRecorded', receipt, new Set())).toBe('tipReceipt');
    expect(pickTip(TIPS, 'expenseRecorded', { ...BASE, expense: PLAIN_EXPENSE }, new Set())).toBe(
      'tipFirstExpense',
    );
  });

  it('gives tipBudget on /month only without a budget limit', () => {
    expect(pickTip(TIPS, 'monthShown', BASE, new Set())).toBe('tipBudget');
    expect(pickTip(TIPS, 'monthShown', { ...BASE, hasBudgetLimit: true }, new Set())).toBe(
      undefined,
    );
  });

  it('gives tipEncrypt in the hub only for an owned, unsealed personal ledger', () => {
    expect(pickTip(TIPS, 'settingsShown', BASE, new Set())).toBe('tipEncrypt');
    for (const ctx of [
      { ...BASE, sealed: true },
      { ...BASE, ledgerKind: 'shared' as const },
      { ...BASE, ownsLedger: false },
    ]) {
      expect(pickTip(TIPS, 'settingsShown', ctx, new Set())).toBeUndefined();
    }
  });
});
