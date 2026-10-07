import { messages } from './messages.js';
import { decodeChartPayload, payloadParam, type ChartPayload } from './payload.js';

export const SVG = 'http://www.w3.org/2000/svg';

// The inline-style properties the chart writes. They go through CSSOM only: the CSP has no
// style-src, so a `style` attribute would be blocked (index.html).
export interface ChartStyle {
  maxWidth: string;
  display: string;
  margin: string;
}

// The slice of the DOM the chart builds with. Every string from the payload reaches the page
// through `textContent` only, never parsed as markup.
// `N` is the node type itself: `HTMLElement | SVGElement` on the page.
export interface ChartNode<N> {
  textContent: string | null;
  readonly style: ChartStyle;
  setAttribute(name: string, value: string): void;
  append(...nodes: N[]): void;
}

export interface ChartDocument<N extends ChartNode<N>> {
  title: string;
  createElement(tag: string): N;
  createElementNS(namespace: typeof SVG, tag: string): N;
}

// Colours from Telegram's theme (`Telegram.WebApp.themeParams`), absent outside Telegram.
export interface ChartTheme {
  readonly bg?: string | undefined;
  readonly hint?: string | undefined;
}

// Categorical slice colours, in line order; a twelfth category reuses the first.
const PALETTE = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#bab0ac',
  '#86bcb6',
];
const NEUTRAL = '#999999';
// The donut's hole, as a fraction of its outer radius 1.
const DONUT_INNER = 0.6;
// A centre text longer than this many characters is squeezed into CENTRE_WIDTH by textLength.
// CENTRE_FONT is sized so that about CENTRE_FIT characters fill CENTRE_WIDTH unsqueezed, since
// textLength also stretches a short text to the full width.
const CENTRE_FIT = 12;
const CENTRE_WIDTH = '1.1';
const CENTRE_FONT = '0.16';
const CAPTION_FONT = '0.11';
const DONUT_MAX_WIDTH = '360px';

// Chart mode: titles the page and draws the payload in `hash` into `root`. A missing `d` shows
// the open-from-bot line, and a `d` the page can't read shows the broken-chart line; neither
// draws anything.
export function showChart<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  hash: string,
  theme: ChartTheme = {},
): void {
  doc.title = messages.chartTitle;
  if (payloadParam(hash) === undefined) {
    root.append(paragraph(doc, messages.openFromBot));
    return;
  }
  const payload = decodeChartPayload(hash);
  if (payload === undefined) {
    root.append(paragraph(doc, messages.chartBroken));
    return;
  }
  drawChart(doc, root, payload, theme);
}

// The title, the total, the donut of the first (converted) currency block with its legend, then
// one line per currency with no rate, which is never drawn.
export function drawChart<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  payload: ChartPayload,
  theme: ChartTheme = {},
): void {
  const title = doc.createElement('h1');
  title.textContent = payload.title;
  root.append(title, paragraph(doc, payload.totalLabel));
  const colours = payload.lines.map(([, amountMinor], index) =>
    amountMinor > 0 ? (PALETTE[index % PALETTE.length] ?? NEUTRAL) : (theme.hint ?? NEUTRAL),
  );
  const donut = drawDonut(doc, payload, colours, theme);
  if (donut !== undefined) root.append(donut);
  const legend = doc.createElement('ul');
  payload.lines.forEach(([name, , label], index) => {
    const item = doc.createElement('li');
    const swatch = svgNode(doc, 'svg', { width: '12', height: '12', viewBox: '0 0 12 12' });
    swatch.append(
      svgNode(doc, 'rect', { width: '12', height: '12', fill: colours[index] ?? NEUTRAL }),
    );
    const text = doc.createElement('span');
    text.textContent = ` ${name}: ${label}`;
    item.append(swatch, text);
    legend.append(item);
  });
  root.append(legend);
  for (const line of payload.unconverted) root.append(paragraph(doc, line));
}

// One annular slice per line with a positive amount, angles in proportion to the amounts, and
// the total in the hole. Floats here are geometry only; no amount shown comes from them.
// Undefined when no line is positive.
function drawDonut<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  payload: ChartPayload,
  colours: readonly string[],
  theme: ChartTheme,
): N | undefined {
  const slices = payload.lines
    .map(([, amountMinor], index) => ({ amountMinor, colour: colours[index] ?? NEUTRAL }))
    .filter((slice) => slice.amountMinor > 0);
  const whole = slices.reduce((sum, slice) => sum + slice.amountMinor, 0);
  if (whole <= 0) return undefined;
  const svg = svgNode(doc, 'svg', {
    width: '100%',
    viewBox: '-1.02 -1.02 2.04 2.04',
    role: 'img',
    'aria-label': `${payload.title}: ${payload.totalLabel}`,
  });
  svg.style.maxWidth = DONUT_MAX_WIDTH;
  svg.style.display = 'block';
  svg.style.margin = '0 auto';
  const edge = { stroke: theme.bg ?? '#ffffff', 'stroke-width': '0.01' };
  if (slices.length === 1) {
    svg.append(
      svgNode(doc, 'path', {
        d: ring(),
        'fill-rule': 'evenodd',
        fill: slices[0]?.colour ?? NEUTRAL,
      }),
    );
  } else {
    let before = 0;
    for (const slice of slices) {
      const start = (before / whole) * 2 * Math.PI;
      before += slice.amountMinor;
      const end = (before / whole) * 2 * Math.PI;
      svg.append(svgNode(doc, 'path', { d: sector(start, end), fill: slice.colour, ...edge }));
    }
  }
  svg.append(
    centreText(doc, payload.totalLabel, { y: '0.04', 'font-size': CENTRE_FONT }),
    centreText(doc, messages.chartTotalCaption, { y: '0.22', 'font-size': CAPTION_FONT }),
  );
  return svg;
}

// The annular slice from `start` to `end` radians: out along the outer arc clockwise, then back
// along the inner arc.
function sector(start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const r = DONUT_INNER;
  return (
    `M ${point(start, 1)} A 1 1 0 ${large} 1 ${point(end, 1)} ` +
    `L ${point(end, r)} A ${r} ${r} 0 ${large} 0 ${point(start, r)} Z`
  );
}

// The whole ring, for a single slice: an arc can't span 360°, so each circle is two half arcs,
// and the even-odd rule leaves the inner one as the hole.
function ring(): string {
  const r = DONUT_INNER;
  return (
    'M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z ' +
    `M 0 -${r} A ${r} ${r} 0 1 1 0 ${r} A ${r} ${r} 0 1 1 0 -${r} Z`
  );
}

// The point at `radius` on the ray `angle` radians clockwise from 12 o'clock.
function point(angle: number, radius: number): string {
  const round = (n: number) => String(Math.round(n * 10000) / 10000);
  return `${round(Math.sin(angle) * radius)} ${round(-Math.cos(angle) * radius)}`;
}

// A text line centred in the hole, set through `textContent`. Past CENTRE_FIT characters it is
// squeezed to CENTRE_WIDTH so it can't run over the ring.
function centreText<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  value: string,
  attributes: Record<string, string>,
): N {
  const squeeze =
    Array.from(value).length > CENTRE_FIT
      ? { textLength: CENTRE_WIDTH, lengthAdjust: 'spacingAndGlyphs' }
      : {};
  const node = svgNode(doc, 'text', {
    x: '0',
    'text-anchor': 'middle',
    fill: 'currentColor',
    ...attributes,
    ...squeeze,
  });
  node.textContent = value;
  return node;
}

export function svgNode<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  tag: string,
  attributes: Record<string, string>,
): N {
  const node = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function paragraph<N extends ChartNode<N>>(doc: ChartDocument<N>, text: string): N {
  const p = doc.createElement('p');
  p.textContent = text;
  return p;
}
