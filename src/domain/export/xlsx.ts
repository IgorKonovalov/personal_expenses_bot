import { currencyExponent } from '../currencies.js';
import { decimalAmount } from '../money.js';
import type { ExportCell, ExportTable } from './rows.js';
import { writeZip, type ZipEntry } from './zip.js';

// An XLSX workbook with one worksheet per table (ADR-0026). Text is in inline-string cells,
// XML-escaped, with every character XML 1.0 forbids dropped. An amount is a numeric cell whose
// `<v>` is the exact decimal with a dot, styled with as many decimals as its currency's
// exponent. Nothing else: no shared strings, formulas or column widths.

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
// Custom number formats start at 164; 0-163 are built in.
const FIRST_CUSTOM_FORMAT = 164;

export function writeXlsx(tables: readonly ExportTable[]): Buffer {
  return writeZip(xlsxParts(tables));
}

// The package parts, in the order they are zipped.
export function xlsxParts(tables: readonly ExportTable[]): ZipEntry[] {
  if (tables.length === 0) throw new Error('a workbook needs a sheet');
  const exponents = [...new Set(tables.flatMap(amountExponents))].sort((a, b) => a - b);
  // Cell style 0 is the default; style i + 1 has exponents[i] decimals.
  const styleOf = new Map(exponents.map((exponent, i) => [exponent, i + 1]));
  const sheets = tables.map((table, i) => ({ table, path: `worksheets/sheet${i + 1}.xml` }));
  const part = (name: string, xml: string): ZipEntry => ({
    name,
    data: Buffer.from(XML_HEADER + xml, 'utf8'),
  });
  return [
    part('[Content_Types].xml', contentTypes(sheets.map((s) => s.path))),
    part(
      '_rels/.rels',
      `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    part('xl/workbook.xml', workbook(tables.map((t) => t.name))),
    part('xl/_rels/workbook.xml.rels', workbookRels(sheets.map((s) => s.path))),
    part('xl/styles.xml', styles(exponents)),
    ...sheets.map(({ table, path }) => part(`xl/${path}`, worksheet(table, styleOf))),
  ];
}

function amountExponents(table: ExportTable): number[] {
  return table.rows.flatMap((row) =>
    row.flatMap((cell) => (cell.kind === 'amount' ? [currencyExponent(cell.currency)] : [])),
  );
}

function contentTypes(sheetPaths: readonly string[]): string {
  const overrides = [
    `<Override PartName="/xl/workbook.xml" ContentType="${CONTENT_TYPE}.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="${CONTENT_TYPE}.styles+xml"/>`,
    ...sheetPaths.map(
      (path) => `<Override PartName="/xl/${path}" ContentType="${CONTENT_TYPE}.worksheet+xml"/>`,
    ),
  ];
  return (
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `${overrides.join('')}</Types>`
  );
}

function workbook(names: readonly string[]): string {
  const sheets = names.map(
    (name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  );
  return `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheets.join('')}</sheets></workbook>`;
}

function workbookRels(sheetPaths: readonly string[]): string {
  const rels = sheetPaths.map(
    (path, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="${path}"/>`,
  );
  rels.push(
    `<Relationship Id="rId${sheetPaths.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`,
  );
  return `<Relationships xmlns="${PACKAGE_REL_NS}">${rels.join('')}</Relationships>`;
}

// One custom number format and one cell style per exponent: `0`, `0.00`, …
function styles(exponents: readonly number[]): string {
  const formats = exponents.map(
    (exponent, i) =>
      `<numFmt numFmtId="${FIRST_CUSTOM_FORMAT + i}" formatCode="${exponent === 0 ? '0' : `0.${'0'.repeat(exponent)}`}"/>`,
  );
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    ...exponents.map(
      (_, i) =>
        `<xf numFmtId="${FIRST_CUSTOM_FORMAT + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    ),
  ];
  return (
    `<styleSheet xmlns="${MAIN_NS}">` +
    (formats.length === 0
      ? ''
      : `<numFmts count="${formats.length}">${formats.join('')}</numFmts>`) +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

function worksheet(table: ExportTable, styleOf: ReadonlyMap<number, number>): string {
  const header: ExportCell[] = table.columns.map((c) => ({ kind: 'text', value: c.header }));
  const rows = [header, ...table.rows].map((row, r) => {
    const cells = row.map((cell, c) => cellXml(cell, `${columnName(c)}${r + 1}`, styleOf));
    return `<row r="${r + 1}">${cells.join('')}</row>`;
  });
  return `<worksheet xmlns="${MAIN_NS}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

function cellXml(cell: ExportCell, ref: string, styleOf: ReadonlyMap<number, number>): string {
  switch (cell.kind) {
    case 'text':
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`;
    case 'amount': {
      const style = styleOf.get(currencyExponent(cell.currency)) ?? 0;
      const value = decimalAmount({ amountMinor: cell.minor, currency: cell.currency }, '.');
      return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
    }
    case 'empty':
      return '';
  }
}

// 0 -> A, 25 -> Z, 26 -> AA.
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  // A raw CR would be read back as a line feed.
  '\r': '&#13;',
};

// Escapes markup and drops what XML 1.0 can't hold: control characters other than tab, LF and
// CR, U+FFFE, U+FFFF and unpaired surrogates.
export function escapeXml(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const forbidden =
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xfffe ||
      code === 0xffff ||
      (code >= 0xd800 && code <= 0xdfff);
    if (!forbidden) out += ENTITIES[char] ?? char;
  }
  return out;
}
