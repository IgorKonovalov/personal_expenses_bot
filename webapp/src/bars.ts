import { decodeChartPayload, type TrendBar } from './payload.js';
import type { ChartDocument, ChartNode, ChartTheme } from './pie.js';

const SVG = 'http://www.w3.org/2000/svg';
// Telegram's default button colour, for a page opened outside Telegram.
const BUTTON = '#2481cc';
const EARLIER_OPACITY = '0.5';
// One row per period: a text line «period · amount» at x 0, then under it a bar that may use the
// full width. No text is placed relative to a bar's end, so no label can run past the viewBox.
const ROW = 30;
const TEXT_BASELINE = 12;
const BAR_TOP = 16;
const BAR_HEIGHT = 10;
const WIDTH = 320;
const MAX_WIDTH = '480px';

// The trend section under the pie: the payload in `hash` drawn as bars, when it has a trend.
// A hash the page can't read draws nothing here; the pie's fallback line already says why.
export function showTrend<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  hash: string,
  theme: ChartTheme = {},
): void {
  const trend = decodeChartPayload(hash)?.trend;
  if (trend !== undefined && trend.length > 0) root.append(drawTrend(doc, trend, theme));
}

// One horizontal bar per period, oldest at the top, its length in proportion to the largest
// total. A period with nothing spent keeps its row and text, with a zero-length bar. The shown
// (last) period's bar is in the theme's button colour, earlier ones in the same colour at half
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

// An SVG text node at x 0 in the page's text colour, its string set through `textContent` only.
function text<N extends ChartNode<N>>(doc: ChartDocument<N>, value: string, y: string): N {
  const node = svgNode(doc, 'text', { x: '0', y, 'font-size': '11', fill: 'currentColor' });
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
