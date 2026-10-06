import { describe, expect, it } from 'vitest';
import { parseRaiffeisenRs, parseStatementAmount } from './raiffeisenRs.js';
import {
  cardRow,
  statementLines,
  TWO_PAGE_ROWS,
  type StatementRowFixture,
} from './testing/raiffeisenStatement.js';

describe('parseRaiffeisenRs', () => {
  it('returns exactly the card purchases of a two-page statement', () => {
    const lines = statementLines(TWO_PAGE_ROWS, { rowsPerPage: 6 });
    expect(new Set(lines.map((line) => line.page))).toEqual(new Set([1, 2]));

    const result = parseRaiffeisenRs(lines);

    expect(result).toEqual({
      kind: 'statement',
      period: { from: '2026-09-01', to: '2026-09-30' },
      purchases: [
        {
          date: '2026-09-02',
          amountMinor: 45000,
          currency: 'RSD',
          merchant: 'PRODAVNICA PRIMER BEOGRAD',
          debitRsdMinor: 45000,
          ordinal: 0,
        },
        {
          date: '2026-09-05',
          amountMinor: 123456,
          currency: 'RSD',
          merchant: 'SUPERMARKET PRIMER NOVI SAD BULEVAR OSLOBOĐENJA 1',
          debitRsdMinor: 123456,
          ordinal: 0,
        },
        {
          date: '2026-09-07',
          amountMinor: 1500,
          currency: 'USD',
          merchant: 'EXAMPLE.COM AMSTERDAM',
          debitRsdMinor: 175685,
          ordinal: 0,
        },
        {
          date: '2026-09-07',
          amountMinor: 30,
          currency: 'EUR',
          merchant: 'EXAMPLE.COM AMSTERDAM',
          debitRsdMinor: 3516,
          ordinal: 0,
        },
        {
          date: '2026-09-14',
          amountMinor: 200000,
          currency: 'RSD',
          merchant: 'APOTEKA PRIMER',
          debitRsdMinor: 200000,
          ordinal: 0,
        },
        {
          date: '2026-09-20',
          amountMinor: 45000,
          currency: 'RSD',
          merchant: 'KAFE PRIMER',
          debitRsdMinor: 45000,
          ordinal: 0,
        },
      ],
    });
  });

  it('takes the transaction date, not the booking date', () => {
    const result = parseRaiffeisenRs(
      statementLines([{ ...cardRow('05.09.2026', '100.00', 'PRIMER'), booked: '06.09.2026' }]),
    );
    expect(result.kind === 'statement' && result.purchases.map((p) => p.date)).toEqual([
      '2026-09-05',
    ]);
  });

  it('numbers identical rows in statement order', () => {
    const row = cardRow('02.09.2026', '450.00', 'KAFE PRIMER');
    const result = parseRaiffeisenRs(
      statementLines([row, cardRow('02.09.2026', '450.00', 'DRUGI PRIMER'), row]),
    );
    expect(
      result.kind === 'statement' && result.purchases.map((p) => [p.merchant, p.ordinal]),
    ).toEqual([
      ['KAFE PRIMER', 0],
      ['DRUGI PRIMER', 0],
      ['KAFE PRIMER', 1],
    ]);
  });

  it('does not join a page footer into the last row of a page', () => {
    const rows: StatementRowFixture[] = [
      cardRow('02.09.2026', '1.00', 'PRVI'),
      cardRow('03.09.2026', '2.00', 'DRUGI'),
    ];
    const result = parseRaiffeisenRs(statementLines(rows, { rowsPerPage: 1 }));
    expect(result.kind === 'statement' && result.purchases.map((p) => p.merchant)).toEqual([
      'PRVI',
      'DRUGI',
    ]);
  });

  it('is not this statement without the title', () => {
    expect(parseRaiffeisenRs(statementLines(TWO_PAGE_ROWS, { title: false }))).toEqual({
      kind: 'notThisStatement',
    });
  });

  it('is not this statement without the table header', () => {
    expect(parseRaiffeisenRs(statementLines(TWO_PAGE_ROWS, { header: false }))).toEqual({
      kind: 'notThisStatement',
    });
  });

  it('is not this statement for no lines', () => {
    expect(parseRaiffeisenRs([])).toEqual({ kind: 'notThisStatement' });
  });

  it('reads a statement with no purchases as one', () => {
    expect(parseRaiffeisenRs(statementLines([]))).toEqual({
      kind: 'statement',
      period: { from: '2026-09-01', to: '2026-09-30' },
      purchases: [],
    });
  });
});

describe('parseStatementAmount', () => {
  it.each([
    ['1,234.56', 'RSD', 123456],
    ['15.00', 'USD', 1500],
    ['0.30', 'EUR', 30],
    ['1,000,000.00', 'RSD', 100000000],
    ['-450.00', 'RSD', -45000],
    ['0.00', 'RSD', 0],
    ['1,500.00', 'JPY', 1500],
  ] as const)('reads %s %s as %d minor units', (text, currency, minor) => {
    expect(parseStatementAmount(text, currency)).toBe(minor);
  });

  it.each(['1.234,56', '1234,56', '12.5', '1,23.00', '', '1,500.50 JPY'])('refuses %j', (text) => {
    expect(parseStatementAmount(text, 'RSD')).toBeUndefined();
  });

  it('refuses a fraction a zero-exponent currency cannot hold', () => {
    expect(parseStatementAmount('1,500.50', 'JPY')).toBeUndefined();
  });
});
