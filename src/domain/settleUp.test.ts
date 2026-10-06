import { describe, expect, it } from 'vitest';
import { greedyTransfers, settleBalances, transfersHash, type SettleMember } from './settleUp.js';
import type { LocalDate } from './time.js';

const day = (d: string) => d as LocalDate;
const members: SettleMember<string>[] = ['A', 'B', 'C'].map((id) => ({
  id,
  joinedOn: day('2026-10-01'),
}));
const expense = (paidBy: string, amountMinor: number, occurredOn = '2026-10-02') => ({
  paidBy,
  amountMinor,
  currency: 'RSD' as const,
  occurredOn: day(occurredOn),
});

describe('settleBalances', () => {
  it('A pays 3000 and B 1000 among three: +166667, -33334, -133333, summing to 0', () => {
    const rsd = settleBalances(members, [expense('A', 300000), expense('B', 100000)], []).get(
      'RSD',
    );

    expect(rsd).toEqual(
      new Map([
        ['A', 166667],
        ['B', -33334],
        ['C', -133333],
      ]),
    );
    expect([...(rsd?.values() ?? [])].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a transfer moves the payer up and the receiver down, in its currency', () => {
    const balances = settleBalances(
      members,
      [expense('A', 300000), expense('B', 100000)],
      [{ from: 'C', to: 'A', amountMinor: 133333, currency: 'RSD' }],
    );
    expect(balances.get('RSD')).toEqual(
      new Map([
        ['A', 33334],
        ['B', -33334],
        ['C', 0],
      ]),
    );
  });

  it('shares an expense only with members who had joined by its date', () => {
    const withD = [...members, { id: 'D', joinedOn: day('2026-10-05') }];
    const before = settleBalances(withD, [expense('A', 300000, '2026-10-04')], []).get('RSD');
    const on = settleBalances(withD, [expense('A', 400000, '2026-10-05')], []).get('RSD');

    expect(before?.get('D')).toBe(0);
    expect(on?.get('D')).toBe(-100000);
  });

  it('keeps each currency apart', () => {
    const balances = settleBalances(
      members,
      [expense('A', 300000), { ...expense('A', 2000), currency: 'EUR' as const }],
      [],
    );
    expect(balances.get('RSD')?.get('A')).toBe(200000);
    expect(balances.get('EUR')?.get('A')).toBe(1332);
  });
});

describe('greedyTransfers', () => {
  it('largest debtor pays largest creditor first', () => {
    expect(
      greedyTransfers(
        new Map([
          ['A', 166667],
          ['B', -33334],
          ['C', -133333],
        ]),
      ),
    ).toEqual([
      { from: 'C', to: 'A', amountMinor: 133333 },
      { from: 'B', to: 'A', amountMinor: 33334 },
    ]);
  });

  it('suggests nothing when everyone is square', () => {
    expect(greedyTransfers(new Map([['A', 0]]))).toEqual([]);
  });
});

describe('transfersHash', () => {
  it('is 8 hex digits that change with the list', () => {
    const one = transfersHash([{ from: 'C', to: 'A', amountMinor: 1, currency: 'RSD' }]);
    expect(one).toMatch(/^[0-9a-f]{8}$/);
    expect(transfersHash([{ from: 'C', to: 'A', amountMinor: 2, currency: 'RSD' }])).not.toBe(one);
  });
});
