import type { PaceSection } from './payload.js';
import type { ChartDocument, ChartNode, ChartTheme } from './pie.js';

const SVG = 'http://www.w3.org/2000/svg';
// Telegram's default button and hint colours, for a page opened outside Telegram.
const BUTTON = '#2481cc';
const HINT = '#999999';
const WIDTH = 320;
const HEIGHT = 160;
const MAX_WIDTH = '480px';
const STROKE_WIDTH = '2';
const SWATCH = '12';

// The pace section: one caption per line above the chart, each after a swatch in its line's
// colour, then the lines of cumulative spend by day. Day d of every series sits at the same x,
// d / span of the width, span the longer of the period and the previous series, so a shorter
// previous period ends early; each line starts at 0 before day 1. The y-axis top is the largest
// last point, so no line leaves the viewBox. The previous series is in the theme's hint colour,
// the current one in its button colour, drawn last on top. Floats here are geometry only; every
// amount shown is the bot's caption.
export function drawPace<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  pace: PaceSection,
  theme: ChartTheme = {},
): N[] {
  const accent = theme.button ?? BUTTON;
  const muted = theme.hint ?? HINT;
  const previous = pace.previous ?? [];
  const span = Math.max(pace.days, previous.length, 1);
  const top = Math.max(0, pace.current.at(-1) ?? 0, previous.at(-1) ?? 0);
  const svg = svgNode(doc, 'svg', { width: '100%', viewBox: `0 0 ${WIDTH} ${HEIGHT}` });
  svg.style.maxWidth = MAX_WIDTH;
  svg.style.display = 'block';
  const [currentCaption, secondCaption] = pace.captions;
  const captions = [caption(doc, currentCaption, accent)];
  if (pace.previous !== undefined) {
    svg.append(polyline(doc, previous, span, top, muted));
    if (secondCaption !== undefined) captions.push(caption(doc, secondCaption, muted));
  }
  svg.append(polyline(doc, pace.current, span, top, accent));
  return [...captions, svg];
}

// A line from 0 before day 1 through each day's point, in viewBox units, y growing downward.
function polyline<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  series: readonly number[],
  span: number,
  top: number,
  stroke: string,
): N {
  const points = [[0, 0], ...series.map((amountMinor, index) => [index + 1, amountMinor])].map(
    ([day = 0, amountMinor = 0]) =>
      `${round((day / span) * WIDTH)},${round(HEIGHT - (top > 0 ? (amountMinor / top) * HEIGHT : 0))}`,
  );
  return svgNode(doc, 'polyline', {
    points: points.join(' '),
    fill: 'none',
    stroke,
    'stroke-width': STROKE_WIDTH,
    'stroke-linejoin': 'round',
  });
}

// A caption paragraph: a swatch filled `fill`, then the text through `textContent` only.
function caption<N extends ChartNode<N>>(doc: ChartDocument<N>, value: string, fill: string): N {
  const p = doc.createElement('p');
  const swatch = svgNode(doc, 'svg', { width: SWATCH, height: SWATCH, viewBox: '0 0 12 12' });
  swatch.append(svgNode(doc, 'rect', { width: SWATCH, height: SWATCH, fill }));
  const text = doc.createElement('span');
  text.textContent = ` ${value}`;
  p.append(swatch, text);
  return p;
}

function round(n: number): string {
  return String(Math.round(n * 100) / 100);
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
