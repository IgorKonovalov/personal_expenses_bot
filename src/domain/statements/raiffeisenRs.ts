import { currencyExponent, toCurrencyCode, type CurrencyCode } from '../currencies.js';
import { parseLocalDate, type LocalDate } from '../time.js';
import type {
  ParseStatementResult,
  PositionedCell,
  PositionedLine,
  StatementPeriod,
  StatementPurchase,
} from './types.js';

// Raiffeisen banka Srbija's «Izvod po tekućem računu» (Plan 0027's layout section): the card
// purchases out of positioned lines (ADR-0033). The statement is recognised by its title and
// its table header; each cell goes to the column whose header cell starts nearest its x.

export const RAIFFEISEN_RS = 'raiffeisen-rs';

type Column =
  | 'date'
  | 'booked'
  | 'card'
  | 'description'
  | 'reference'
  | 'original'
  | 'debit'
  | 'credit'
  | 'balance';

// A header cell names its column by how it starts, after folding case.
const HEADER_PREFIXES: readonly (readonly [Column, string])[] = [
  ['date', 'datum prijema'],
  ['booked', 'datum izvr'],
  ['card', 'broj kartice'],
  ['description', 'opis promene'],
  ['reference', 'iznos u ref'],
  ['original', 'iznos u orig'],
  ['debit', 'isplata'],
  ['credit', 'uplata'],
  ['balance', 'stanje'],
];

const TITLE = /izvod po teku[cć]em ra[cč]unu/i;
const PERIOD = /\bOd (\d{2}\.\d{2}\.\d{4}) do (\d{2}\.\d{2}\.\d{4})\b/;
const DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const CARD = /^\d{4}$/;
// `1,234.56`: comma thousands, dot decimals, an optional minus.
const AMOUNT = /^(-?)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/;
const ORIGINAL = /^(-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2}) ([A-Z]{3})$/;
// The closing balance line: no further row follows it.
const CLOSING = /^STANJE\b/;
// A wrapped description line further below its row than this ends the row.
const MAX_LINE_GAP = 16;

type Anchors = readonly (readonly [Column, number])[];

interface OpenRow {
  readonly page: number;
  lastY: number;
  readonly cells: Map<Column, string[]>;
}

export function parseRaiffeisenRs(lines: readonly PositionedLine[]): ParseStatementResult {
  if (!lines.some((line) => TITLE.test(lineText(line)))) return { kind: 'notThisStatement' };

  // Each page repeats the header: rows are read only below it, until the page ends.
  let anchors: Anchors | undefined;
  let headerSeen = false;
  let page = 0;
  let row: OpenRow | undefined;
  let closed = false;
  const rows: OpenRow[] = [];
  const finish = () => {
    if (row !== undefined) rows.push(row);
    row = undefined;
  };

  for (const line of lines) {
    if (line.page !== page) {
      finish();
      page = line.page;
      anchors = undefined;
    }
    const header = headerAnchors(line);
    if (header !== undefined) {
      finish();
      anchors = header;
      headerSeen = true;
      continue;
    }
    if (anchors === undefined || closed) continue;
    if (CLOSING.test(lineText(line))) {
      finish();
      closed = true;
      continue;
    }

    const cells = assign(line.cells, anchors);
    if (startsRow(cells)) {
      finish();
      row = { page: line.page, lastY: line.y, cells };
      continue;
    }
    // A wrapped description, or the «Kurs:» line under the original amount. Anything else, or a
    // line too far below, is no part of the row: a page footer, a total.
    const continues =
      row !== undefined &&
      line.y - row.lastY <= MAX_LINE_GAP &&
      [...cells.keys()].every((column) => column === 'description' || column === 'original');
    if (!continues || row === undefined) {
      finish();
      continue;
    }
    row.lastY = line.y;
    const description = cells.get('description');
    if (description !== undefined) {
      row.cells.set('description', [...(row.cells.get('description') ?? []), ...description]);
    }
  }
  finish();
  if (!headerSeen) return { kind: 'notThisStatement' };

  return {
    kind: 'statement',
    period: findPeriod(lines),
    purchases: withOrdinals(rows.flatMap((r) => purchaseOf(r.cells) ?? [])),
  };
}

function lineText(line: PositionedLine): string {
  return line.cells.map((cell) => cell.text).join(' ');
}

// The header line's columns and the x each starts at, when every column is there.
function headerAnchors(line: PositionedLine): Anchors | undefined {
  const anchors: [Column, number][] = [];
  for (const [column, prefix] of HEADER_PREFIXES) {
    const cell = line.cells.find((c) => c.text.trim().toLowerCase().startsWith(prefix));
    if (cell === undefined) return undefined;
    anchors.push([column, cell.x]);
  }
  return anchors;
}

function assign(cells: readonly PositionedCell[], anchors: Anchors): Map<Column, string[]> {
  const byColumn = new Map<Column, string[]>();
  for (const cell of cells) {
    let nearest: Column = 'description';
    let distance = Infinity;
    for (const [column, x] of anchors) {
      if (Math.abs(cell.x - x) < distance) {
        distance = Math.abs(cell.x - x);
        nearest = column;
      }
    }
    byColumn.set(nearest, [...(byColumn.get(nearest) ?? []), cell.text.trim()]);
  }
  return byColumn;
}

function joined(cells: Map<Column, string[]>, column: Column): string {
  return (cells.get(column) ?? []).join(' ').replace(/\s+/g, ' ').trim();
}

// A row starts on a line with both dates.
function startsRow(cells: Map<Column, string[]>): boolean {
  return (
    parseDate(joined(cells, 'date')) !== undefined &&
    parseDate(joined(cells, 'booked')) !== undefined
  );
}

function parseDate(text: string): LocalDate | undefined {
  const match = DATE.exec(text);
  if (match === null) return undefined;
  const [, day, month, year] = match;
  return parseLocalDate(`${year}-${month}-${day}`);
}

// A card purchase: a 4-digit card, a positive debit, no credit, and an original amount with its
// currency. Every other row (a withdrawal, a fee, a transfer, a reversal) is not one.
function purchaseOf(cells: Map<Column, string[]>): Omit<StatementPurchase, 'ordinal'> | undefined {
  const date = parseDate(joined(cells, 'date'));
  if (date === undefined || !CARD.test(joined(cells, 'card'))) return undefined;
  const debit = parseStatementAmount(joined(cells, 'debit'), 'RSD');
  const credit = parseStatementAmount(joined(cells, 'credit'), 'RSD');
  if (debit === undefined || debit <= 0 || credit !== 0) return undefined;
  // The «Kurs:» line shares the column; the amount is the first line in it.
  const original = ORIGINAL.exec(cells.get('original')?.[0] ?? '');
  if (original === null) return undefined;
  const [, amountText = '', code = ''] = original;
  const currency = toCurrencyCode(code);
  if (currency === undefined) return undefined;
  const amountMinor = parseStatementAmount(amountText, currency);
  if (amountMinor === undefined || amountMinor <= 0) return undefined;
  const merchant = joined(cells, 'description');
  if (merchant === '') return undefined;
  return { date, amountMinor, currency, merchant, debitRsdMinor: debit };
}

// `1,234.56` to minor units by the currency's exponent, on the digits: 123456 for RSD. Two
// decimals that a zero-exponent currency can't hold must be zeros.
export function parseStatementAmount(text: string, currency: CurrencyCode): number | undefined {
  const match = AMOUNT.exec(text);
  if (match === null) return undefined;
  const [, sign = '', integer = '', fraction = ''] = match;
  const exponent = currencyExponent(currency);
  if (!/^0*$/.test(fraction.slice(exponent))) return undefined;
  const digits = (integer.replaceAll(',', '') + fraction.slice(0, exponent)).replace(
    /^0+(?=\d)/,
    '',
  );
  if (digits.length > 15) return undefined;
  const minor = Number(digits);
  return sign === '-' && minor !== 0 ? -minor : minor;
}

function findPeriod(lines: readonly PositionedLine[]): StatementPeriod | undefined {
  for (const line of lines) {
    const match = PERIOD.exec(lineText(line));
    if (match === null) continue;
    const from = parseDate(match[1] ?? '');
    const to = parseDate(match[2] ?? '');
    if (from !== undefined && to !== undefined) return { from, to };
  }
  return undefined;
}

function withOrdinals(
  purchases: readonly Omit<StatementPurchase, 'ordinal'>[],
): StatementPurchase[] {
  const seen = new Map<string, number>();
  return purchases.map((purchase) => {
    const key = JSON.stringify([
      purchase.date,
      purchase.amountMinor,
      purchase.currency,
      purchase.merchant,
    ]);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { ...purchase, ordinal };
  });
}
