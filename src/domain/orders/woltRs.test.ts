import { describe, expect, it } from 'vitest';
import { statementLines, TWO_PAGE_ROWS } from '../statements/testing/raiffeisenStatement.js';
import type { PositionedLine } from '../statements/types.js';
import { WOLT_ORDER, woltOrderLines } from './testing/buildWoltRs.js';
import type { LocalDateTime } from './types.js';
import { deliveredInstant, parseWoltRs } from './woltRs.js';

function orderOf(lines: readonly PositionedLine[]) {
  const result = parseWoltRs(lines);
  if (result.kind !== 'order') throw new Error(`expected an order, got ${result.kind}`);
  return result.order;
}

describe('parseWoltRs', () => {
  it('reads the order id, restaurant, delivery, total and the two dishes', () => {
    expect(parseWoltRs(woltOrderLines())).toEqual({
      kind: 'order',
      order: {
        source: 'wolt-rs',
        orderId: '0123456789abcdef01234567',
        restaurant: 'Primer Kuhinja',
        sellerTaxId: '123456789',
        deliveredAt: '2026-10-12 13:26',
        totalMinor: 114400,
        currency: 'RSD',
        items: [
          { name: 'Nudle sa povrćem', quantity: '1', totalMinor: 97500 },
          { name: 'Prolećne rolnice', quantity: '1', totalMinor: 16900 },
        ],
      },
    });
  });

  it('carries neither the customer name nor the card digits', () => {
    const serialised = JSON.stringify(parseWoltRs(woltOrderLines()));
    expect(serialised).not.toContain('Test Korisnik');
    expect(serialised).not.toContain('0000');
  });

  it('strips left-to-right and right-to-left marks before reading a cell', () => {
    const marked = woltOrderLines().map((line) => ({
      ...line,
      cells: line.cells.map((cell) =>
        /\d,\d{2}$/.test(cell.text) ? { ...cell, text: `‎${cell.text}‏` } : cell,
      ),
    }));
    expect(orderOf(marked).totalMinor).toBe(114400);
  });

  it('reads a dish quantity from its own indented line, then its item line', () => {
    const order = orderOf(
      woltOrderLines({
        payments: [{ label: 'Visa: ****0000', amount: '2.119,00' }],
        items: [
          { name: 'Nudle sa povrćem', total: '1.950,00', quantity: '2' },
          { name: 'Prolećne rolnice', total: '169,00', quantity: '0,5', compact: true },
        ],
        total: '2.119,00',
      }),
    );
    expect(order.items).toEqual([
      { name: 'Nudle sa povrćem', quantity: '2', totalMinor: 195000 },
      { name: 'Prolećne rolnice', quantity: '0.5', totalMinor: 16900 },
    ]);
  });

  it('refuses an order whose dishes do not sum to the total', () => {
    expect(parseWoltRs(woltOrderLines({ total: '1.244,00' }))).toEqual({
      kind: 'unreadableOrder',
    });
  });

  it('refuses an order whose payments do not sum to the total', () => {
    const payments = [...WOLT_ORDER.payments, { label: 'Wolt krediti', amount: '100,00' }];
    expect(parseWoltRs(woltOrderLines({ payments }))).toEqual({ kind: 'unreadableOrder' });
  });

  it('refuses a total in another currency, a missing label and a pickup order', () => {
    expect(parseWoltRs(woltOrderLines({ totalLabel: 'Ukupno u EUR (sa PDV-om)' }))).toEqual({
      kind: 'unreadableOrder',
    });
    expect(parseWoltRs(woltOrderLines({ pib: '' }))).toEqual({ kind: 'unreadableOrder' });
    expect(parseWoltRs(woltOrderLines({ orderType: 'Preuzimanje' }))).toEqual({
      kind: 'unreadableOrder',
    });
    expect(parseWoltRs(woltOrderLines({ delivered: '32.10.2026 13:26' }))).toEqual({
      kind: 'unreadableOrder',
    });
  });

  it('gives notThisOrder for a Raiffeisen statement', () => {
    expect(parseWoltRs(statementLines(TWO_PAGE_ROWS, { rowsPerPage: 6 }))).toEqual({
      kind: 'notThisOrder',
    });
  });
});

describe('deliveredInstant', () => {
  it('reads the wall clock in Serbia: CEST is UTC+2 until 2026-10-25', () => {
    expect(deliveredInstant('2026-10-12 13:26' as LocalDateTime).toISOString()).toBe(
      '2026-10-12T11:26:00.000Z',
    );
    expect(deliveredInstant('2026-10-12 01:30' as LocalDateTime).toISOString()).toBe(
      '2026-10-11T23:30:00.000Z',
    );
    expect(deliveredInstant('2026-11-12 13:26' as LocalDateTime).toISOString()).toBe(
      '2026-11-12T12:26:00.000Z',
    );
  });
});
