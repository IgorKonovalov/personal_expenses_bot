// Test-only: synthetic Raiffeisen banka Srbija statements («Izvod po tekućem računu») as
// positioned lines and as PDFs, following the layout in Plan 0027. Every value is made up: the
// account, card `0000`, merchants and amounts are not from any real statement.

import type { PositionedLine } from '../types.js';
import { buildPdf } from './buildPdf.js';

export interface StatementRowFixture {
  // DD.MM.YYYY
  readonly date: string;
  // DD.MM.YYYY; the transaction date when omitted.
  readonly booked?: string;
  // `''` for a row without a card (a withdrawal, a fee, a transfer).
  readonly card: string;
  // One entry per printed line.
  readonly description: readonly string[];
  // «Iznos u orig. valuti», e.g. `15.00 USD`; `''` for none.
  readonly original: string;
  // The «Kurs:» line under the original amount, for a foreign one.
  readonly rate?: string;
  readonly debit: string;
  readonly credit?: string;
}

// The left edges of the table columns, in points.
export const COLUMN_X = {
  date: 20,
  booked: 130,
  card: 200,
  description: 250,
  reference: 450,
  original: 520,
  debit: 610,
  credit: 690,
  balance: 760,
} as const;

const HEADER: readonly (readonly [keyof typeof COLUMN_X, string])[] = [
  ['date', 'Datum prijema/Datum transakcije'],
  ['booked', 'Datum izvršenja'],
  ['card', 'Broj kartice'],
  ['description', 'Opis promene'],
  ['reference', 'Iznos u ref. valuti'],
  ['original', 'Iznos u orig. valuti'],
  ['debit', 'Isplata'],
  ['credit', 'Uplata'],
  ['balance', 'Stanje'],
];

export const STATEMENT_ACCOUNT = '000-0000000000000-00';
const LINE_GAP = 9;
const ROW_GAP = 5;
const TABLE_TOP = 120;
const FOOTER_Y = 560;

export interface StatementFixtureOptions {
  readonly rowsPerPage?: number;
  // DD.MM.YYYY
  readonly from?: string;
  readonly to?: string;
  // Leaves out the title, or the table header, on every page.
  readonly title?: boolean;
  readonly header?: boolean;
}

export function statementLines(
  rows: readonly StatementRowFixture[],
  options: StatementFixtureOptions = {},
): PositionedLine[] {
  const rowsPerPage = options.rowsPerPage ?? 20;
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const lines: PositionedLine[] = [];
  for (let index = 0; index < pageCount; index++) {
    const page = index + 1;
    const line = (y: number, ...cells: [number, string][]) =>
      lines.push({ page, y, cells: cells.map(([x, text]) => ({ x, text })) });
    if (options.title !== false) {
      line(40, [20, `Izvod po tekućem računu broj ${STATEMENT_ACCOUNT}`]);
    }
    line(
      54,
      [20, `Od ${options.from ?? '01.09.2026'} do ${options.to ?? '30.09.2026'}`],
      [400, 'Valuta: RSD'],
    );
    line(68, [20, 'PRIMER PRIMEROVIĆ'], [700, `Strana: ${page}/${pageCount}`]);
    if (options.header !== false)
      line(100, ...HEADER.map(([key, text]) => [COLUMN_X[key], text] as [number, string]));

    let y = TABLE_TOP;
    for (const row of rows.slice(index * rowsPerPage, (index + 1) * rowsPerPage)) {
      const [first = '', ...rest] = row.description;
      const cells: [number, string][] = [
        [COLUMN_X.date, row.date],
        [COLUMN_X.booked, row.booked ?? row.date],
      ];
      if (row.card !== '') cells.push([COLUMN_X.card, row.card]);
      cells.push([COLUMN_X.description, first]);
      if (row.original !== '') {
        cells.push([COLUMN_X.reference, row.debit], [COLUMN_X.original, row.original]);
      }
      cells.push(
        [COLUMN_X.debit, row.debit],
        [COLUMN_X.credit, row.credit ?? '0.00'],
        [COLUMN_X.balance, '100,000.00'],
      );
      line(y, ...cells);
      const under = Math.max(rest.length, row.rate === undefined ? 0 : 1);
      for (let n = 0; n < under; n++) {
        y += LINE_GAP;
        const continued: [number, string][] = [];
        const text = rest[n];
        if (text !== undefined) continued.push([COLUMN_X.description, text]);
        if (n === 0 && row.rate !== undefined)
          continued.push([COLUMN_X.original, `Kurs: ${row.rate}`]);
        line(y, ...continued);
      }
      y += LINE_GAP + ROW_GAP;
    }
    if (page === pageCount) line(y + 10, [20, 'STANJE'], [COLUMN_X.balance, '100,000.00']);
    line(FOOTER_Y, [20, 'Primer banka a.d. Beograd, Ulica Primer 1, 11000 Beograd']);
  }
  return lines;
}

export function statementPdf(
  rows: readonly StatementRowFixture[],
  options: StatementFixtureOptions = {},
): Uint8Array {
  const lines = statementLines(rows, options);
  const pageCount = Math.max(...lines.map((line) => line.page));
  return buildPdf(
    Array.from({ length: pageCount }, (_, index) =>
      lines.filter((line) => line.page === index + 1),
    ),
  );
}

// A card purchase in RSD.
export function cardRow(date: string, amount: string, merchant: string): StatementRowFixture {
  return {
    date,
    card: '0000',
    description: [merchant],
    original: `${amount} RSD`,
    debit: amount,
  };
}

// Two pages: six card purchases among rows that are not purchases. The card rows, in order:
// 450.00 RSD, a three-line merchant at 1,234.56 RSD, 15.00 USD and its 0.30 EUR conversion
// charge, 2,000.00 RSD, and 450.00 RSD on another day.
export const TWO_PAGE_ROWS: readonly StatementRowFixture[] = [
  cardRow('02.09.2026', '450.00', 'PRODAVNICA PRIMER BEOGRAD'),
  {
    date: '03.09.2026',
    card: '',
    description: ['Gotovinska isplata', 'BANKOMAT PRIMER 1'],
    original: '',
    debit: '5,000.00',
  },
  {
    date: '05.09.2026',
    booked: '06.09.2026',
    card: '0000',
    description: ['SUPERMARKET PRIMER', 'NOVI SAD BULEVAR', 'OSLOBOĐENJA 1'],
    original: '1,234.56 RSD',
    debit: '1,234.56',
  },
  {
    date: '07.09.2026',
    card: '0000',
    description: ['EXAMPLE.COM', 'AMSTERDAM'],
    original: '15.00 USD',
    rate: '117.1234',
    debit: '1,756.85',
  },
  {
    date: '07.09.2026',
    card: '0000',
    description: ['EXAMPLE.COM', 'AMSTERDAM'],
    original: '0.30 EUR',
    rate: '117.2000',
    debit: '35.16',
  },
  {
    date: '10.09.2026',
    card: '',
    description: ['Naknada za vođenje računa'],
    original: '',
    debit: '250.00',
  },
  {
    date: '11.09.2026',
    card: '',
    description: ['Zarada za avgust', 'PRIMER DOO'],
    original: '',
    debit: '0.00',
    credit: '150,000.00',
  },
  {
    date: '12.09.2026',
    card: '0000',
    description: ['PRODAVNICA PRIMER BEOGRAD'],
    original: '450.00 RSD',
    debit: '-450.00',
  },
  cardRow('14.09.2026', '2,000.00', 'APOTEKA PRIMER'),
  cardRow('20.09.2026', '450.00', 'KAFE PRIMER'),
];
