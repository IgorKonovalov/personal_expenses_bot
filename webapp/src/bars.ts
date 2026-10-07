import { decodeChartPayload, type TrendBar } from './payload.js';
import type { ChartDocument, ChartNode, ChartTheme } from './pie.js';

const SVG = 'http://www.w3.org/2000/svg';
const BAR_COLOUR = '#4e79a7';
const NEUTRAL = '#999999';
// One row per period: its name, the bar, then the formatted total past the bar's end.
const ROW = 24;
const LABEL_WIDTH = 110;
const BAR_WIDTH = 110;
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
// total. A period with nothing spent keeps its row and name, with a zero-length bar. Floats here
// are geometry only; every amount shown is the bot's label.
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
  trend.forEach(([periodLabel, totalMinor, label], index) => {
    const top = index * ROW;
    const length = largest > 0 && totalMinor > 0 ? (totalMinor / largest) * BAR_WIDTH : 0;
    const rounded = Math.round(length * 100) / 100;
    const baseline = String(top + ROW / 2 + 4);
    svg.append(
      text(doc, periodLabel, { x: '0', y: baseline }),
      svgNode(doc, 'rect', {
        x: String(LABEL_WIDTH),
        y: String(top + 4),
        width: String(rounded),
        height: String(ROW - 8),
        fill: totalMinor > 0 ? BAR_COLOUR : (theme.hint ?? NEUTRAL),
      }),
      text(doc, label, { x: String(LABEL_WIDTH + rounded + 4), y: baseline }),
    );
  });
  return svg;
}

// An SVG text node in the page's text colour, its string set through `textContent` only.
function text<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  value: string,
  position: { x: string; y: string },
): N {
  const node = svgNode(doc, 'text', { ...position, 'font-size': '11', fill: 'currentColor' });
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
