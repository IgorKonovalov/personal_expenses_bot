import { describe, expect, it } from 'vitest';
import { writeCsv } from './csv.js';
import type { ExportTable } from './rows.js';

// Test-only RFC 4180 reader with `;` as the separator: quoted fields may hold the separator,
// doubled quotes and line breaks; records end with CRLF.
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '"' && field === '') {
      i++;
      for (;;) {
        const next = text[i];
        if (next === undefined) throw new Error('unterminated quoted field');
        if (next === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += next;
        i++;
      }
    } else if (char === ';') {
      record.push(field);
      field = '';
      i++;
    } else if (char === '\r' && text[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 2;
    } else {
      field += char;
      i++;
    }
  }
  if (field !== '' || record.length > 0) throw new Error('last record has no CRLF');
  return records;
}

function decoded(bytes: Buffer): string {
  return bytes.subarray(3).toString('utf8');
}

const table = (description: string): ExportTable => ({
  name: 'Расходы',
  columns: [{ header: 'Дата' }, { header: 'Сумма' }, { header: 'Валюта' }, { header: 'Описание' }],
  rows: [
    [
      { kind: 'text', value: '2026-09-30' },
      { kind: 'amount', minor: 45000, currency: 'RSD' },
      { kind: 'text', value: 'RSD' },
      { kind: 'text', value: description },
    ],
    [
      { kind: 'text', value: '2026-09-30' },
      { kind: 'amount', minor: 1500, currency: 'JPY' },
      { kind: 'text', value: 'JPY' },
      { kind: 'empty' },
    ],
  ],
});

describe('writeCsv', () => {
  it('starts with the UTF-8 BOM and writes CRLF records with ; and a decimal comma', () => {
    const bytes = writeCsv(table('кофе'));

    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decoded(bytes)).toBe(
      'Дата;Сумма;Валюта;Описание\r\n2026-09-30;450,00;RSD;кофе\r\n2026-09-30;1500;JPY;\r\n',
    );
  });

  it('round-trips a description holding ;, " and a line break through an RFC 4180 reader', () => {
    const description = 'a;b "c"\r\nd\ne';
    const records = parseCsv(decoded(writeCsv(table(description))));

    expect(records).toHaveLength(3);
    expect(records[1]).toEqual(['2026-09-30', '450,00', 'RSD', description]);
  });

  it('leaves a plain field unquoted', () => {
    expect(decoded(writeCsv(table('такси')))).toContain(';такси\r\n');
  });
});
