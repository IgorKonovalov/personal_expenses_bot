import { describe, expect, it } from 'vitest';
import { parseRaiffeisenRs } from '../domain/statements/raiffeisenRs.js';
import { buildPdf } from '../domain/statements/testing/buildPdf.js';
import {
  statementLines,
  statementPdf,
  TWO_PAGE_ROWS,
} from '../domain/statements/testing/raiffeisenStatement.js';
import { readPdfLines } from './pdf.js';

describe('readPdfLines', () => {
  it('reads a page back as lines of cells that reproduce its rows', async () => {
    const bytes = buildPdf([
      [
        { y: 40, cells: [{ x: 20, text: 'Izvod po tekućem računu broj 000-0000000000000-00' }] },
        {
          y: 100,
          cells: [
            { x: 20, text: 'Datum prijema' },
            { x: 166, text: 'Opis promene' },
            { x: 540, text: 'Isplata' },
          ],
        },
        // Out of order on purpose: lines come back top to bottom, cells left to right.
        {
          y: 134,
          cells: [
            { x: 540, text: '2,000.00' },
            { x: 20, text: '14.09.2026' },
            { x: 166, text: 'APOTEKA PRIMER ČAČAK' },
          ],
        },
        {
          y: 120,
          cells: [
            { x: 20, text: '02.09.2026' },
            { x: 166, text: 'PRODAVNICA PRIMER ĐURĐEVO' },
            { x: 540, text: '450.00' },
          ],
        },
      ],
    ]);

    const lines = await readPdfLines(bytes);

    expect(lines).toEqual([
      {
        page: 1,
        y: 40,
        cells: [{ x: 20, text: 'Izvod po tekućem računu broj 000-0000000000000-00' }],
      },
      {
        page: 1,
        y: 100,
        cells: [
          { x: 20, text: 'Datum prijema' },
          { x: 166, text: 'Opis promene' },
          { x: 540, text: 'Isplata' },
        ],
      },
      {
        page: 1,
        y: 120,
        cells: [
          { x: 20, text: '02.09.2026' },
          { x: 166, text: 'PRODAVNICA PRIMER ĐURĐEVO' },
          { x: 540, text: '450.00' },
        ],
      },
      {
        page: 1,
        y: 134,
        cells: [
          { x: 20, text: '14.09.2026' },
          { x: 166, text: 'APOTEKA PRIMER ČAČAK' },
          { x: 540, text: '2,000.00' },
        ],
      },
    ]);
  });

  it('numbers the lines of each page', async () => {
    const bytes = buildPdf([
      [{ y: 40, cells: [{ x: 20, text: 'prva' }] }],
      [{ y: 40, cells: [{ x: 20, text: 'druga' }] }],
    ]);

    const lines = await readPdfLines(bytes);

    expect(lines.map((line) => [line.page, line.cells[0]?.text])).toEqual([
      [1, 'prva'],
      [2, 'druga'],
    ]);
  });

  it('reads a synthetic statement PDF into the purchases its lines hold', async () => {
    const lines = await readPdfLines(statementPdf(TWO_PAGE_ROWS, { rowsPerPage: 6 }));

    expect(parseRaiffeisenRs(lines)).toEqual(
      parseRaiffeisenRs(statementLines(TWO_PAGE_ROWS, { rowsPerPage: 6 })),
    );
    expect(parseRaiffeisenRs(lines)).toMatchObject({ kind: 'statement' });
  });

  it('gives no lines for a PDF without text', async () => {
    expect(await readPdfLines(buildPdf([[], []]))).toEqual([]);
  });

  it('leaves the caller’s bytes intact', async () => {
    const bytes = buildPdf([[{ y: 40, cells: [{ x: 20, text: 'x' }] }]]);
    const copy = bytes.slice();

    await readPdfLines(bytes);

    expect(bytes).toEqual(copy);
  });
});
