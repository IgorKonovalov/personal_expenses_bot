import type { PositionedCell, PositionedLine } from '../domain/statements/types.js';

// The statements adapter (ADR-0033): a PDF's text as positioned lines. `pdfjs-dist` is imported
// here only, with a dynamic import(), so it loads on the first statement and never at boot.

// Items whose baselines differ by at most this many points share a line.
const LINE_TOLERANCE = 2;

interface TextItem {
  readonly str: string;
  readonly transform: readonly number[];
}

// Every page's text items grouped into lines by baseline, top to bottom, each line's cells
// sorted by x. Whitespace-only items are dropped, so a PDF with no text gives []. The bytes are
// read in memory and never written anywhere.
export async function readPdfLines(bytes: Uint8Array): Promise<PositionedLine[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    useSystemFonts: false,
    disableFontFace: true,
  });
  try {
    const doc = await task.promise;
    const lines: PositionedLine[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const { height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter(
        (item): item is TextItem & (typeof content.items)[number] =>
          'str' in item && item.str.trim() !== '',
      );
      lines.push(...groupLines(number, height, items));
      page.cleanup();
    }
    return lines;
  } finally {
    await task.destroy();
  }
}

function groupLines(page: number, height: number, items: readonly TextItem[]): PositionedLine[] {
  const placed = items
    .map((item) => ({
      x: round(item.transform[4] ?? 0),
      y: round(height - (item.transform[5] ?? 0)),
      text: item.str,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; cells: PositionedCell[] }[] = [];
  for (const item of placed) {
    const last = lines.at(-1);
    if (last !== undefined && item.y - last.y <= LINE_TOLERANCE) {
      last.cells.push({ x: item.x, text: item.text });
    } else {
      lines.push({ y: item.y, cells: [{ x: item.x, text: item.text }] });
    }
  }
  return lines.map(({ y, cells }) => ({
    page,
    y,
    cells: cells.sort((a, b) => a.x - b.x),
  }));
}

// Positions to a hundredth of a point: enough to tell columns apart, stable across runs.
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
