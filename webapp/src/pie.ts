import { messages } from './messages.js';
import { decodeChartPayload, payloadParam, type ChartPayload } from './payload.js';

// The slice of the DOM the chart builds with. Every string from the payload reaches the page
// through `textContent` only, never parsed as markup.
// `N` is the node type itself: `Element` on the page.
export interface ChartNode<N> {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  append(...nodes: N[]): void;
}

export interface ChartDocument<N extends ChartNode<N>> {
  createElement(tag: string): N;
  createElementNS(namespace: string, tag: string): N;
}

// Colours from Telegram's theme (`Telegram.WebApp.themeParams`), absent outside Telegram.
export interface ChartTheme {
  readonly bg?: string | undefined;
  readonly hint?: string | undefined;
}

const SVG = 'http://www.w3.org/2000/svg';
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
const SIZE = '240';

// Chart mode: draws the payload in `hash` into `root`. A missing `d` shows the open-from-bot
// line, and a `d` the page can't read shows the broken-chart line; neither draws anything.
export function showChart<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  hash: string,
  theme: ChartTheme = {},
): void {
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

// The title, the total, the pie of the first (converted) currency block with its legend, then
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
  const pie = drawPie(doc, payload, colours, theme);
  if (pie !== undefined) root.append(pie);
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

// One slice per line with a positive amount, angles in proportion to the amounts. Floats here
// are geometry only; no amount shown comes from them. Undefined when no line is positive.
function drawPie<N extends ChartNode<N>>(
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
  const svg = svgNode(doc, 'svg', { width: SIZE, height: SIZE, viewBox: '-1.02 -1.02 2.04 2.04' });
  const edge = { stroke: theme.bg ?? '#ffffff', 'stroke-width': '0.01' };
  if (slices.length === 1) {
    svg.append(svgNode(doc, 'circle', { r: '1', fill: slices[0]?.colour ?? NEUTRAL }));
    return svg;
  }
  let before = 0;
  for (const slice of slices) {
    const start = (before / whole) * 2 * Math.PI;
    before += slice.amountMinor;
    const end = (before / whole) * 2 * Math.PI;
    const large = end - start > Math.PI ? 1 : 0;
    const d = `M 0 0 L ${point(start)} A 1 1 0 ${large} 1 ${point(end)} Z`;
    svg.append(svgNode(doc, 'path', { d, fill: slice.colour, ...edge }));
  }
  return svg;
}

// The point on the unit circle `angle` radians clockwise from 12 o'clock.
function point(angle: number): string {
  const round = (n: number) => String(Math.round(n * 10000) / 10000);
  return `${round(Math.sin(angle))} ${round(-Math.cos(angle))}`;
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

function paragraph<N extends ChartNode<N>>(doc: ChartDocument<N>, text: string): N {
  const p = doc.createElement('p');
  p.textContent = text;
  return p;
}
