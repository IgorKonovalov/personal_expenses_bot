import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from '../currencies.js';
import type { LocalDate } from '../time.js';
import { matchRows, type MatchCandidate } from './match.js';

function row(date: string, amountMinor: number, currency: CurrencyCode = 'RSD') {
  return { date: date as LocalDate, amountMinor, currency };
}

function expense(
  id: string,
  occurredOn: string,
  amountMinor: number,
  options: { currency?: CurrencyCode; at?: string } = {},
): MatchCandidate {
  return {
    id,
    amountMinor,
    currency: options.currency ?? 'RSD',
    occurredOn: occurredOn as LocalDate,
    occurredAt: new Date(options.at ?? `${occurredOn}T12:00:00Z`),
  };
}

describe('matchRows', () => {
  it('matches 1 250 RSD recorded on the 12th to a row of the 13th, not of the 14th', () => {
    const recorded = [expense('e1', '2026-09-12', 125000)];

    expect(matchRows([row('2026-09-13', 125000)], recorded)).toEqual(['e1']);
    expect(matchRows([row('2026-09-14', 125000)], recorded)).toEqual([undefined]);
    expect(matchRows([row('2026-09-11', 125000)], recorded)).toEqual(['e1']);
  });

  it('matches across a month end', () => {
    expect(matchRows([row('2026-10-01', 100)], [expense('e1', '2026-09-30', 100)])).toEqual(['e1']);
  });

  it('gives two identical rows against one expense one match and one new row', () => {
    expect(
      matchRows(
        [row('2026-09-12', 45000), row('2026-09-12', 45000)],
        [expense('e1', '2026-09-12', 45000)],
      ),
    ).toEqual(['e1', undefined]);
  });

  it('needs the same currency and amount', () => {
    const recorded = [expense('e1', '2026-09-07', 1500, { currency: 'USD' })];

    expect(
      matchRows([row('2026-09-07', 1500, 'USD'), row('2026-09-07', 175685, 'RSD')], recorded),
    ).toEqual(['e1', undefined]);
    expect(matchRows([row('2026-09-07', 1500, 'EUR')], recorded)).toEqual([undefined]);
    expect(matchRows([row('2026-09-07', 1501, 'USD')], recorded)).toEqual([undefined]);
  });

  it('takes the closest date first', () => {
    expect(
      matchRows(
        [row('2026-09-12', 100)],
        [expense('far', '2026-09-11', 100), expense('same', '2026-09-12', 100)],
      ),
    ).toEqual(['same']);
  });

  it('breaks a date tie by the earlier occurred_at, then the lower id', () => {
    expect(
      matchRows(
        [row('2026-09-12', 100)],
        [
          expense('a', '2026-09-12', 100, { at: '2026-09-12T15:00:00Z' }),
          expense('b', '2026-09-12', 100, { at: '2026-09-12T09:00:00Z' }),
        ],
      ),
    ).toEqual(['b']);
    expect(
      matchRows(
        [row('2026-09-12', 100)],
        [expense('d', '2026-09-12', 100), expense('c', '2026-09-12', 100)],
      ),
    ).toEqual(['c']);
  });

  it('matches rows in statement order, so an earlier row keeps its closest expense', () => {
    expect(
      matchRows(
        [row('2026-09-12', 100), row('2026-09-13', 100)],
        [expense('e12', '2026-09-12', 100), expense('e13', '2026-09-13', 100)],
      ),
    ).toEqual(['e12', 'e13']);
  });
});
