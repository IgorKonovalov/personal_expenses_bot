// Test-only: a synthetic Wolt Serbia order confirmation («Potvrda porudžbine») as positioned
// lines and as a PDF, following the layout in Plan 0051. Every value is made up: the customer,
// the order id, the restaurant, the PIB and card `0000` are not from any real order.

import { buildPdf } from '../../statements/testing/buildPdf.js';
import type { PositionedCell, PositionedLine } from '../../statements/types.js';

// Where each cell starts, in points.
export const WOLT_X = {
  label: 52,
  indent: 70,
  customer: 481,
  orderId: 405,
  restaurant: 509,
  orderType: 517,
  delivered: 467,
  payment: 514,
  headerVat: 269,
  headerQuantity: 328,
  headerGross: 400,
  headerTotal: 532,
  vat: 283,
  quantity: 364,
  gross: 457,
  itemTotal: 524,
  optionGross: 470,
  optionTotal: 538,
  total: 514,
} as const;

export interface WoltOptionFixture {
  readonly name: string;
  readonly gross: string;
  readonly total: string;
}

export interface WoltItemFixture {
  readonly name: string;
  readonly total: string;
  readonly quantity?: string;
  readonly vat?: string;
  // One full line at the margin, with no indented dish line or options.
  readonly compact?: boolean;
  readonly options?: readonly WoltOptionFixture[];
}

export interface WoltOrderFixture {
  readonly title: string;
  readonly customer: string;
  readonly orderId: string;
  readonly restaurant: string;
  readonly orderType: string;
  // DD.MM.YYYY HH:MM
  readonly delivered: string;
  readonly payments: readonly { readonly label: string; readonly amount: string }[];
  readonly items: readonly WoltItemFixture[];
  readonly totalLabel: string;
  readonly total: string;
  readonly seller: string;
  readonly pib: string;
  readonly x: typeof WOLT_X;
}

export const WOLT_ORDER: WoltOrderFixture = {
  title: 'Potvrda porudžbine #SRB/26/10000001/7/180',
  customer: 'Test Korisnik',
  orderId: '0123456789abcdef01234567',
  restaurant: 'Primer Kuhinja',
  orderType: 'Dostava',
  delivered: '12.10.2026 13:26',
  payments: [{ label: 'Visa: ****0000', amount: '1.144,00' }],
  items: [
    {
      name: 'Nudle sa povrćem',
      total: '975,00',
      options: [{ name: 'Da li želiš pribor?: Ne, hvala', gross: '0,00', total: '0,00' }],
    },
    { name: 'Prolećne rolnice', total: '169,00', compact: true },
  ],
  totalLabel: 'Ukupno u RSD (sa PDV-om)',
  total: '1.144,00',
  seller: 'Prodavac: PRIMER KUHINJA PR',
  pib: '123456789',
  x: WOLT_X,
};

const TOP = 40;
const LINE_GAP = 14;

export function woltOrderLines(
  overrides: Partial<WoltOrderFixture> = {},
): readonly PositionedLine[] {
  const f = { ...WOLT_ORDER, ...overrides };
  const { x } = f;
  const rows: PositionedCell[][] = [
    [{ x: x.label, text: f.title }],
    [
      { x: x.label, text: 'Korisnik' },
      { x: x.customer, text: f.customer },
    ],
    [
      { x: x.label, text: 'ID porudžbine' },
      { x: x.orderId, text: f.orderId },
    ],
    [
      { x: x.label, text: 'Lokacija' },
      { x: x.restaurant, text: f.restaurant },
    ],
    [
      { x: x.label, text: 'Vrsta porudžbine' },
      { x: x.orderType, text: f.orderType },
    ],
    [
      { x: x.label, text: 'Vreme dostave' },
      { x: x.delivered, text: f.delivered },
    ],
    [{ x: x.label, text: 'Način plaćanja' }],
    ...f.payments.map((payment) => [
      { x: x.label, text: payment.label },
      { x: x.payment, text: payment.amount },
    ]),
    [
      { x: x.label, text: 'Artikal' },
      { x: x.headerVat, text: 'PDV %' },
      { x: x.headerQuantity, text: 'Količina' },
      { x: x.headerGross, text: 'Bruto cena artikla' },
      { x: x.headerTotal, text: 'Cena' },
    ],
    ...f.items.flatMap((item) => itemRows(item, x)),
    [
      { x: x.label, text: f.totalLabel },
      { x: x.total, text: f.total },
    ],
    [{ x: x.label, text: f.seller }],
    [{ x: x.label, text: `PIB: ${f.pib}` }],
  ];
  return rows.map((cells, index) => ({ page: 1, y: TOP + index * LINE_GAP, cells }));
}

function itemRows(item: WoltItemFixture, x: typeof WOLT_X): PositionedCell[][] {
  const full = (left: number, name: string): PositionedCell[] => [
    { x: left, text: name },
    { x: x.vat, text: item.vat ?? '20%' },
    { x: x.quantity, text: item.quantity ?? '1' },
    { x: x.gross, text: item.total },
    { x: x.itemTotal, text: item.total },
  ];
  if (item.compact === true) return [full(x.label, item.name)];
  return [
    [
      { x: x.label, text: item.name },
      { x: x.itemTotal, text: item.total },
    ],
    full(x.indent, item.name),
    ...(item.options ?? []).map((option) => [
      { x: x.indent, text: option.name },
      { x: x.vat, text: item.vat ?? '20%' },
      { x: x.quantity, text: '1' },
      { x: x.optionGross, text: option.gross },
      { x: x.optionTotal, text: option.total },
    ]),
  ];
}

export function woltOrderPdf(overrides: Partial<WoltOrderFixture> = {}): Uint8Array {
  return buildPdf([woltOrderLines(overrides).map(({ y, cells }) => ({ y, cells }))]);
}
