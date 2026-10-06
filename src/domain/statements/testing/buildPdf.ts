// Test-only: writes positioned text as a minimal PDF, one Helvetica text object per cell, so the
// statements adapter can be driven by a real file. Nothing here comes from a real statement.

import type { PositionedLine } from '../types.js';

// A4 landscape, in points.
export const PDF_PAGE_WIDTH = 842;
export const PDF_PAGE_HEIGHT = 595;
const FONT_SIZE = 7;

// WinAnsi has `š ž Š Ž` but not the rest of Serbian Latin, so those take free codes through the
// font's /Differences and reach Unicode through the standard glyph names.
const DIFFERENCES: readonly (readonly [number, string, string])[] = [
  [0x80, 'Dcroat', 'Đ'],
  [0x81, 'cacute', 'ć'],
  [0x8d, 'ccaron', 'č'],
  [0x8f, 'dcroat', 'đ'],
  [0x90, 'Cacute', 'Ć'],
  [0x9d, 'Ccaron', 'Č'],
];
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = { Š: 0x8a, Ž: 0x8e, š: 0x9a, ž: 0x9e };

function encodeText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const extra = DIFFERENCES.find(([, , c]) => c === char)?.[0] ?? WIN_ANSI_EXTRA[char];
    if (extra !== undefined) out += `\\${extra.toString(8).padStart(3, '0')}`;
    else if (char === '\\' || char === '(' || char === ')') out += `\\${char}`;
    else if (code >= 0x20 && code < 0x7f) out += char;
    else throw new Error(`buildPdf cannot encode ${JSON.stringify(char)}`);
  }
  return out;
}

// `pages[i]` holds page i+1's lines (their `page` is ignored); y counts down from the top edge.
// A page with no lines gets a drawn rectangle and no text, like a scan's text layer.
export function buildPdf(pages: readonly (readonly Omit<PositionedLine, 'page'>[])[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);

  const catalog = add('');
  const pageTree = add('');
  const differences = DIFFERENCES.map(([code, name]) => `${code} /${name}`).join(' ');
  const font = add(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding ` +
      `/BaseEncoding /WinAnsiEncoding /Differences [${differences}] >> >>`,
  );
  const pageIds: number[] = [];
  for (const lines of pages) {
    const content =
      lines.length === 0
        ? '0 0 0 RG 50 50 200 100 re S'
        : lines
            .flatMap((line) =>
              line.cells.map(
                (cell) =>
                  `BT /F1 ${FONT_SIZE} Tf ${cell.x} ${PDF_PAGE_HEIGHT - line.y} Td ` +
                  `(${encodeText(cell.text)}) Tj ET`,
              ),
            )
            .join('\n');
    const stream = add(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
