import { decimalAmount } from '../money.js';
import type { ExportCell, ExportTable } from './rows.js';

// CSV for Excel in the ru/sr locales (ADR-0026): UTF-8 with a BOM, `;` between cells, a decimal
// comma, CRLF after every record, and RFC 4180 quoting of any cell holding `;`, `"`, CR or LF.
// A text cell a spreadsheet would read as a formula (starting with `=`, `+`, `-`, `@`, a tab or
// a CR) gets a `'` prepended. Amount cells are numbers and are never prefixed.

const BOM = '﻿';
const SEPARATOR = ';';
const NEEDS_QUOTES = /[;"\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function writeCsv(table: ExportTable): Buffer {
  const records = [
    table.columns.map((column) => quoted(column.header)),
    ...table.rows.map((row) => row.map(cellText)),
  ];
  const body = records.map((record) => `${record.join(SEPARATOR)}\r\n`).join('');
  return Buffer.from(BOM + body, 'utf8');
}

function cellText(cell: ExportCell): string {
  switch (cell.kind) {
    case 'text':
      return quoted(FORMULA_START.test(cell.value) ? `'${cell.value}` : cell.value);
    case 'amount':
      return decimalAmount({ amountMinor: cell.minor, currency: cell.currency }, ',');
    case 'empty':
      return '';
  }
}

function quoted(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
