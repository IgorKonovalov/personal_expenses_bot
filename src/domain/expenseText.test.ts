import { describe, expect, it } from 'vitest';
import { parseExpenseText } from './expenseText.js';

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
