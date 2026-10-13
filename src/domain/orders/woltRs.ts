import { TZDate } from '@date-fns/tz';
import type { FetchedItem } from '../receipts/types.js';
import type { PositionedCell, PositionedLine } from '../statements/types.js';
import { parseLocalDate } from '../time.js';
import type { DeliveryOrder, LocalDateTime, ParseOrderResult } from './types.js';

// Wolt Serbia's order confirmation («Potvrda porudžbine», Plan 0051's layout section) out of
// positioned lines (ADR-0033). Labels sit in the left column with their value in the line's
// last cell. The dish table runs from its header to «Ukupno»: a line at the table's left margin
// starts an item and carries its total, and the indented lines under it are the dish's own line
// and its options. A product name too long for its column wraps around a row of numbers alone.
// Every check that fails gives `unreadableOrder`, never a guess. The customer's name and the card
// digits are never read.

export const WOLT_RS = 'wolt-rs';
// «Vreme dostave» is a wall-clock time in Serbia.
export const WOLT_RS_TIMEZONE = 'Europe/Belgrade';

const TITLE = /^Potvrda porudžbine #/;
const ORDER_ID = /^[0-9a-f]{24}$/;
const PIB = /^PIB:\s*(\d{9})$/;
const DELIVERED = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;
// `1.144,00`: dot thousands, comma decimals.
const AMOUNT = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/;
const QUANTITY = /^\d+(?:,\d+)?$/;
const VAT_RATE = /^\d+%$/;
const TOTAL = /^Ukupno u ([A-Z]{3})\b/;
// A cell within this many points of the table's margin starts at it.
const MARGIN_TOLERANCE = 2;

// pdftotext shows a left-to-right mark before each amount; pdf.js may hand it over too.
function clean(text: string): string {
  return text.replace(/[‎‏]/g, '').trim();
}

function cleanLine(line: PositionedLine): PositionedLine {
  return {
    ...line,
    cells: line.cells
      .map((cell) => ({ x: cell.x, text: clean(cell.text) }))
      .filter((cell) => cell.text !== ''),
  };
}

function lineText(line: PositionedLine): string {
  return line.cells.map((cell) => cell.text).join(' ');
}

// Straight to integer minor units on the digits, never through a float.
function parseAmount(text: string): number | undefined {
  const match = AMOUNT.exec(text);
  if (match === null) return undefined;
  const [, whole = '', fraction = ''] = match;
  return Number(`${whole.replaceAll('.', '')}${fraction}`.replace(/^0+(?=\d)/, ''));
}

function lastCell(line: PositionedLine): PositionedCell | undefined {
  return line.cells.length < 2 ? undefined : line.cells.at(-1);
}

// The value of the left-column label `label`: the last cell of the one line it heads.
function labelValue(lines: readonly PositionedLine[], label: string): string | undefined {
  const found = lines.filter((line) => line.cells[0]?.text === label);
  if (found.length !== 1) return undefined;
  const [line] = found;
  return line === undefined ? undefined : lastCell(line)?.text;
}

function parseDelivered(text: string): LocalDateTime | undefined {
  const match = DELIVERED.exec(text);
  if (match === null) return undefined;
  const [, day = '', month = '', year = '', hour = '', minute = ''] = match;
  if (parseLocalDate(`${year}-${month}-${day}`) === undefined) return undefined;
  if (Number(hour) > 23 || Number(minute) > 59) return undefined;
  return `${year}-${month}-${day} ${hour}:${minute}` as LocalDateTime;
}

// The instant an order's wall-clock delivery time names in Serbia.
export function deliveredInstant(deliveredAt: LocalDateTime): Date {
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0] = deliveredAt
    .split(/[- :]/)
    .map(Number);
  return new Date(new TZDate(year, month - 1, day, hour, minute, WOLT_RS_TIMEZONE).getTime());
}

interface TableColumns {
  readonly margin: number;
  // The «Količina» column runs from its header cell to the next header cell.
  readonly quantityFrom: number;
  readonly quantityTo: number;
}

function tableColumns(header: PositionedLine): TableColumns | undefined {
  const [first] = header.cells;
  const index = header.cells.findIndex((cell) => cell.text === 'Količina');
  const quantity = header.cells[index];
  const next = header.cells[index + 1];
  if (first === undefined || quantity === undefined || next === undefined) return undefined;
  return { margin: first.x, quantityFrom: quantity.x, quantityTo: next.x };
}

// A table line's «Količina» cell, neither its name nor its total.
function quantityOf(line: PositionedLine, columns: TableColumns): string | undefined {
  const cell = line.cells
    .slice(1, -1)
    .find((c) => c.x >= columns.quantityFrom && c.x < columns.quantityTo);
  if (cell === undefined || !QUANTITY.test(cell.text)) return undefined;
  return cell.text.replace(',', '.');
}

interface OpenItem {
  readonly name: string;
  readonly totalMinor: number;
  readonly ownQuantity: string | undefined;
  dishQuantity: string | undefined;
}

// A margin line holding only text: one line of a product name too long for its column.
function isNameOnly(row: PositionedLine, columns: TableColumns): boolean {
  const [first] = row.cells;
  return (
    row.cells.length === 1 &&
    first !== undefined &&
    Math.abs(first.x - columns.margin) <= MARGIN_TOLERANCE
  );
}

// The numbers of an item whose name wraps: no name cell, the row opens on its VAT rate.
function isNumbersOnly(row: PositionedLine, columns: TableColumns): boolean {
  const [first] = row.cells;
  return first !== undefined && first.x > columns.margin && VAT_RATE.test(first.text);
}

function startsItem(row: PositionedLine, columns: TableColumns): boolean {
  const [first] = row.cells;
  if (first === undefined) return false;
  if (isNumbersOnly(row, columns)) return true;
  return Math.abs(first.x - columns.margin) <= MARGIN_TOLERANCE && !isNameOnly(row, columns);
}

// Each item row's name, keyed by its index in `rows`. A wrapped name's lines sit at the margin a
// few points above and below the one row carrying the item's numbers, while items are a full
// row apart, so a name-only line belongs to the nearest item row on its page. A tie, or a
// name-only line with no item row on its page, gives `undefined`.
function itemNames(
  rows: readonly PositionedLine[],
  columns: TableColumns,
): Map<number, string> | undefined {
  const starts = rows.flatMap((row, index) => (startsItem(row, columns) ? [index] : []));
  const parts = new Map<number, { y: number; text: string }[]>(
    starts.map((index) => {
      const row = rows[index];
      const own = row === undefined || isNumbersOnly(row, columns) ? [] : [row];
      return [index, own.map((line) => ({ y: line.y, text: line.cells[0]?.text ?? '' }))];
    }),
  );
  for (const row of rows) {
    if (!isNameOnly(row, columns)) continue;
    const distances = starts
      .filter((index) => rows[index]?.page === row.page)
      .map((index) => ({ index, dy: Math.abs((rows[index]?.y ?? 0) - row.y) }))
      .sort((a, b) => a.dy - b.dy);
    const [nearest, next] = distances;
    if (nearest === undefined || nearest.dy === next?.dy) return undefined;
    parts.get(nearest.index)?.push({ y: row.y, text: row.cells[0]?.text ?? '' });
  }
  const names = new Map<number, string>();
  for (const [index, lines] of parts) {
    if (lines.length === 0) return undefined;
    const ordered = lines.toSorted((a, b) => a.y - b.y).map((line) => line.text);
    names.set(index, ordered.join(' '));
  }
  return names;
}

function readItems(
  rows: readonly PositionedLine[],
  columns: TableColumns,
): FetchedItem[] | undefined {
  const names = itemNames(rows, columns);
  if (names === undefined) return undefined;
  const items: OpenItem[] = [];
  for (const [index, row] of rows.entries()) {
    const [first] = row.cells;
    if (first === undefined || isNameOnly(row, columns)) continue;
    const name = names.get(index);
    if (name !== undefined) {
      const total = lastCell(row);
      const totalMinor = total === undefined ? undefined : parseAmount(total.text);
      if (totalMinor === undefined) return undefined;
      items.push({
        name,
        totalMinor,
        ownQuantity: quantityOf(row, columns),
        dishQuantity: undefined,
      });
      continue;
    }
    const item = items.at(-1);
    if (first.x < columns.margin || item === undefined) return undefined;
    // The dish's own indented line names it; an option line adds nothing.
    if (first.text === item.name && item.dishQuantity === undefined) {
      item.dishQuantity = quantityOf(row, columns);
    }
  }
  return items.map((item) => ({
    name: item.name,
    quantity: item.dishQuantity ?? item.ownQuantity ?? '1',
    totalMinor: item.totalMinor,
  }));
}

export function parseWoltRs(raw: readonly PositionedLine[]): ParseOrderResult {
  const firstPage = raw.filter((line) => line.page === 1);
  if (!firstPage.some((line) => TITLE.test(lineText(line).trimStart()))) {
    return { kind: 'notThisOrder' };
  }
  const order = readOrder(raw.map(cleanLine));
  return order === undefined ? { kind: 'unreadableOrder' } : { kind: 'order', order };
}

function readOrder(lines: readonly PositionedLine[]): DeliveryOrder | undefined {
  const orderId = labelValue(lines, 'ID porudžbine');
  const restaurant = labelValue(lines, 'Lokacija');
  const kind = labelValue(lines, 'Vrsta porudžbine');
  const delivered = labelValue(lines, 'Vreme dostave');
  const pib = lines.map((line) => PIB.exec(lineText(line))).find((match) => match !== null);
  if (orderId === undefined || !ORDER_ID.test(orderId)) return undefined;
  if (restaurant === undefined || restaurant === '') return undefined;
  // A pickup order («Preuzimanje») has a layout not yet seen.
  if (kind !== 'Dostava' || delivered === undefined) return undefined;
  const deliveredAt = parseDelivered(delivered);
  const sellerTaxId = pib?.[1];
  if (deliveredAt === undefined || sellerTaxId === undefined) return undefined;

  const paymentAt = lines.findIndex((line) => line.cells[0]?.text === 'Način plaćanja');
  const headerAt = lines.findIndex(
    (line) => line.cells[0]?.text === 'Artikal' && line.cells.at(-1)?.text === 'Cena',
  );
  const totalAt = lines.findIndex((line) => TOTAL.test(line.cells[0]?.text ?? ''));
  const header = lines[headerAt];
  const totalLine = lines[totalAt];
  if (paymentAt < 0 || header === undefined || totalLine === undefined) return undefined;
  if (!(paymentAt < headerAt && headerAt < totalAt)) return undefined;

  if (TOTAL.exec(totalLine.cells[0]?.text ?? '')?.[1] !== 'RSD') return undefined;
  const totalCell = lastCell(totalLine);
  const totalMinor = totalCell === undefined ? undefined : parseAmount(totalCell.text);
  if (totalMinor === undefined || totalMinor <= 0) return undefined;

  // Every line between «Način plaćanja» and the table is one payment, and they cover the total.
  const payments = lines.slice(paymentAt + 1, headerAt).map((line) => {
    const cell = lastCell(line);
    return cell === undefined ? undefined : parseAmount(cell.text);
  });
  if (payments.length === 0 || payments.some((amount) => amount === undefined)) return undefined;
  if (payments.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) !== totalMinor) {
    return undefined;
  }

  const columns = tableColumns(header);
  if (columns === undefined) return undefined;
  const items = readItems(lines.slice(headerAt + 1, totalAt), columns);
  if (items === undefined || items.length === 0) return undefined;
  if (items.reduce((sum, item) => sum + item.totalMinor, 0) !== totalMinor) return undefined;

  return {
    source: WOLT_RS,
    orderId,
    restaurant,
    sellerTaxId,
    deliveredAt,
    totalMinor,
    currency: 'RSD',
    items,
  };
}
