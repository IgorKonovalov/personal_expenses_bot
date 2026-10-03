import { describe, expect, it } from 'vitest';
import type { ExportTable } from './rows.js';
import { xlsxParts } from './xlsx.js';

const ENTITY = /^&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/;

// Test-only well-formedness check: one root element, balanced tags, and every `&` starting an
// entity. Enough to catch a stray character in user text breaking a part.
function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  while (i < body.length) {
    const char = body.charAt(i);
    if (char === '&') {
      if (!ENTITY.test(body.slice(i))) throw new Error(`bare & at ${i}`);
      i++;
    } else if (char === '<') {
      const end = body.indexOf('>', i);
      if (end < 0) throw new Error(`unclosed tag at ${i}`);
      const tag = body.slice(i + 1, end);
      if (tag.includes('<')) throw new Error(`< inside a tag at ${i}`);
      const name = /^\/?([A-Za-z_][\w:.-]*)/.exec(tag)?.[1];
      if (name === undefined) throw new Error(`bad tag at ${i}`);
      if (tag.startsWith('/')) {
        if (stack.pop() !== name) throw new Error(`unbalanced </${name}> at ${i}`);
      } else {
        if (stack.length === 0) roots++;
        if (!tag.endsWith('/')) stack.push(name);
      }
      i = end + 1;
    } else {
      if (stack.length === 0 && !/\s/.test(char)) throw new Error(`text outside the root at ${i}`);
      i++;
    }
  }
  if (stack.length > 0) throw new Error(`unclosed <${stack.join('>, <')}>`);
  if (roots !== 1) throw new Error(`${roots} root elements`);
}

const EXPENSES: ExportTable = {
  name: 'Расходы',
  columns: [{ header: 'Дата' }, { header: 'Сумма' }, { header: 'Валюта' }, { header: 'Описание' }],
  rows: [
    [
      { kind: 'text', value: '2026-09-30' },
      { kind: 'amount', minor: 45000, currency: 'RSD' },
      { kind: 'text', value: 'RSD' },
      { kind: 'text', value: 'a < b & c\u0001d' },
    ],
    [
      { kind: 'text', value: '2026-09-30' },
      { kind: 'amount', minor: 1500, currency: 'JPY' },
      { kind: 'text', value: 'JPY' },
      { kind: 'empty' },
    ],
  ],
};

const ITEMS: ExportTable = {
  name: 'Позиции чеков',
  columns: [{ header: 'Наименование' }, { header: 'Сумма' }],
  rows: [
    [
      { kind: 'text', value: 'Хлеб' },
      { kind: 'amount', minor: 9999, currency: 'RSD' },
    ],
  ],
};

function partText(tables: readonly ExportTable[], name: string): string {
  const part = xlsxParts(tables).find((p) => p.name === name);
  if (part === undefined) throw new Error(`no part ${name}`);
  return part.data.toString('utf8');
}

// The format code the cell `ref` of sheet 1 is styled with.
function formatOf(tables: readonly ExportTable[], ref: string): string | undefined {
  const sheet = partText(tables, 'xl/worksheets/sheet1.xml');
  const style = new RegExp(`<c r="${ref}" s="(\\d+)">`).exec(sheet)?.[1];
  const stylesXml = partText(tables, 'xl/styles.xml');
  const xfs = /<cellXfs[^>]*>(.*)<\/cellXfs>/.exec(stylesXml)?.[1]?.match(/<xf [^>]*\/>/g) ?? [];
  const formatId = /numFmtId="(\d+)"/.exec(xfs[Number(style)] ?? '')?.[1];
  return new RegExp(`<numFmt numFmtId="${formatId}" formatCode="([^"]*)"/>`).exec(stylesXml)?.[1];
}

describe('xlsxParts', () => {
  it('holds the package parts and one worksheet per table', () => {
    expect(xlsxParts([EXPENSES, ITEMS]).map((p) => p.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
  });

  it('names two sheets Расходы and Позиции чеков with items, and one without', () => {
    const sheetNames = (tables: readonly ExportTable[]) =>
      [...partText(tables, 'xl/workbook.xml').matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);

    expect(sheetNames([EXPENSES, ITEMS])).toEqual(['Расходы', 'Позиции чеков']);
    expect(sheetNames([EXPENSES])).toEqual(['Расходы']);
  });

  it('writes 45000 RSD as <v>450.00</v> styled 0.00, and 1500 JPY as <v>1500</v> styled 0', () => {
    const sheet = partText([EXPENSES], 'xl/worksheets/sheet1.xml');

    expect(sheet).toMatch(/<c r="B2" s="\d+"><v>450\.00<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="B3" s="\d+"><v>1500<\/v><\/c>/);
    expect(formatOf([EXPENSES], 'B2')).toBe('0.00');
    expect(formatOf([EXPENSES], 'B3')).toBe('0');
  });

  it('escapes < and & in a description and drops U+0001', () => {
    const sheet = partText([EXPENSES], 'xl/worksheets/sheet1.xml');

    expect(sheet).toContain('<t xml:space="preserve">a &lt; b &amp; cd</t>');
    expect(sheet).not.toContain('\u0001');
  });

  it('keeps every part well-formed with hostile text in every cell', () => {
    const hostile: ExportTable = {
      name: 'Расходы <&>',
      columns: [{ header: '"\'<&>' }],
      rows: [
        ['</t></is></c>', '&amp', '\u0000\u0008\u000b￿', '\ud800x', 'a\r\nb', ']]>'].map(
          (value) => ({ kind: 'text', value }) as const,
        ),
      ],
    };

    for (const part of xlsxParts([hostile, ITEMS])) {
      expect(() => {
        assertWellFormed(part.data.toString('utf8'));
      }, part.name).not.toThrow();
    }
  });

  it.each(['<a><b></a></b>', '<a>x & y</a>', '<a/><b/>'])(
    'has a checker that rejects %j',
    (xml) => {
      expect(() => {
        assertWellFormed(xml);
      }).toThrow();
    },
  );
});
