import type { BarsSection, TrendBar } from './payload.js';
import type { ChartDocument, ChartNode, ChartTheme } from './pie.js';

const SVG = 'http://www.w3.org/2000/svg';
// Telegram's default button colour, for a page opened outside Telegram.
const BUTTON = '#2481cc';
const EARLIER_OPACITY = '0.5';
// One row per period: a text line «period · amount» at x 0 (a bars row: its label at x 0 and its
// text ending at the right edge), then under it a bar that may use the full width. No text is
// placed relative to a bar's end, so no label can run past the viewBox.
const ROW = 30;
const TEXT_BASELINE = 12;
const BAR_TOP = 16;
const BAR_HEIGHT = 10;
const WIDTH = 320;
const MAX_WIDTH = '480px';

// The trend section: one horizontal bar per period, oldest at the top, its length in proportion
// to the largest total. A period with nothing spent keeps its row and text, with a zero-length
// bar. The shown (last) period's bar is in the theme's button colour, earlier ones in the same colour at half
// opacity. Floats here are geometry only; every amount shown is the bot's label.
export function drawTrend<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  trend: readonly TrendBar[],
  theme: ChartTheme = {},
): N {
  const largest = Math.max(0, ...trend.map(([, totalMinor]) => totalMinor));
  const height = String(trend.length * ROW);
  // Scales with the page; the viewBox keeps the rows' proportions.
  const svg = svgNode(doc, 'svg', { width: '100%', viewBox: `0 0 ${WIDTH} ${height}` });
  svg.style.maxWidth = MAX_WIDTH;
  svg.style.display = 'block';
  const fill = theme.button ?? BUTTON;
  trend.forEach(([periodLabel, totalMinor, label], index) => {
    const top = index * ROW;
    const length = largest > 0 && totalMinor > 0 ? (totalMinor / largest) * WIDTH : 0;
    const shade = index === trend.length - 1 ? {} : { opacity: EARLIER_OPACITY };
    svg.append(
      text(doc, `${periodLabel} · ${label}`, String(top + TEXT_BASELINE)),
      svgNode(doc, 'rect', {
        x: '0',
        y: String(top + BAR_TOP),
        width: String(Math.round(length * 100) / 100),
        height: String(BAR_HEIGHT),
        fill,
        ...shade,
      }),
    );
  });
  return svg;
}

// A bars section: its caption, then one row per bar, oldest at the top, then each note as a line.
// A row is its label at the left and its text at the right, then under them a bar in the theme's
// button colour whose length is in proportion to the largest amount. A row with a null amount
// keeps its label and text and draws no bar. Floats here are geometry only; every amount shown
// is the bot's text.
export function drawBars<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  section: BarsSection,
  theme: ChartTheme = {},
): N[] {
  const amounts = section.rows.flatMap(([, amountMinor]) =>
    amountMinor === null ? [] : [amountMinor],
  );
  const largest = Math.max(0, ...amounts);
  const svg = svgNode(doc, 'svg', {
    width: '100%',
    viewBox: `0 0 ${WIDTH} ${String(section.rows.length * ROW)}`,
  });
  svg.style.maxWidth = MAX_WIDTH;
  svg.style.display = 'block';
  const fill = theme.button ?? BUTTON;
  section.rows.forEach(([label, amountMinor, value], index) => {
    const top = index * ROW;
    const baseline = String(top + TEXT_BASELINE);
    svg.append(text(doc, label, baseline), text(doc, value, baseline, 'end'));
    if (amountMinor === null) return;
    const length = largest > 0 && amountMinor > 0 ? (amountMinor / largest) * WIDTH : 0;
    svg.append(
      svgNode(doc, 'rect', {
        x: '0',
        y: String(top + BAR_TOP),
        width: String(Math.round(length * 100) / 100),
        height: String(BAR_HEIGHT),
        fill,
      }),
    );
  });
  return [line(doc, section.caption), svg, ...(section.notes ?? []).map((note) => line(doc, note))];
}

// A paragraph holding `value` through `textContent` only.
function line<N extends ChartNode<N>>(doc: ChartDocument<N>, value: string): N {
  const node = doc.createElement('p');
  node.textContent = value;
  return node;
}

// An SVG text node in the page's text colour, its string set through `textContent` only: at x 0,
// or ending at the right edge.
function text<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  value: string,
  y: string,
  anchor: 'start' | 'end' = 'start',
): N {
  const node = svgNode(doc, 'text', {
    x: anchor === 'end' ? String(WIDTH) : '0',
    y,
    'font-size': '11',
    fill: 'currentColor',
    ...(anchor === 'end' ? { 'text-anchor': 'end' } : {}),
  });
  node.textContent = value;
  return node;
}

function svgNode<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  tag: string,
  attributes: Record<string, string>,
): N {
  const node = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
