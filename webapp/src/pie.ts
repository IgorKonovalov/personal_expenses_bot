import { messages } from './messages.js';
import { decodeChartPayload, payloadParam, type ChartPayload } from './payload.js';

export const SVG = 'http://www.w3.org/2000/svg';

// The inline-style properties the chart writes. They go through CSSOM only: the CSP has no
// style-src, so a `style` attribute would be blocked (index.html).
export interface ChartStyle {
  maxWidth: string;
  display: string;
  margin: string;
  minHeight: string;
  fontWeight: string;
}

// The slice of the DOM the chart builds with. Every string from the payload reaches the page
// through `textContent` only, never parsed as markup.
// `N` is the node type itself: `HTMLElement | SVGElement` on the page.
export interface ChartNode<N> {
  textContent: string | null;
  readonly style: ChartStyle;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  append(...nodes: N[]): void;
  addEventListener(type: 'click', listener: () => void): void;
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
// A selected line's name past this many characters is cut in the centre; the legend keeps it whole.
const NAME_FIT = 14;
const DIMMED_OPACITY = '0.35';
// The legend row is the main tap target, since a small slice is hard to hit.
const ROW_MIN_HEIGHT = '44px';

// Chart mode: titles the page and draws the payload in `hash` into `root`. A missing `d` shows
// the open-from-bot line, and a `d` the page can't read shows the broken-chart line; neither
// draws anything. `onSelect` runs on every change of the inspected line.
export function showChart<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  hash: string,
  theme: ChartTheme = {},
  onSelect: () => void = () => {},
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
  drawChart(doc, root, payload, theme, onSelect);
}

// The title, the total, the donut of the first (converted) currency block with its tap hint and
// legend, then one line per currency with no rate, which is never drawn. Tapping a slice or a
// legend row inspects that line; tapping it again, or the hole, goes back to the total. The
// selection lives in this closure only: it is never stored or sent.
export function drawChart<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  payload: ChartPayload,
  theme: ChartTheme = {},
  onSelect: () => void = () => {},
): void {
  const title = doc.createElement('h1');
  title.textContent = payload.title;
  root.append(title, paragraph(doc, payload.totalLabel));
  const colours = payload.lines.map(([, amountMinor], index) =>
    amountMinor > 0 ? (PALETTE[index % PALETTE.length] ?? NEUTRAL) : (theme.hint ?? NEUTRAL),
  );
  const donut = drawDonut(doc, payload, colours, theme);
  const items: N[] = [];
  let selected: number | undefined;
  const select = (index: number | undefined) => {
    selected = index;
    if (donut !== undefined) inspect(donut, payload, index);
    items.forEach((item, i) => (item.style.fontWeight = i === index ? 'bold' : ''));
    onSelect();
  };
  const toggle = (index: number) => {
    select(selected === index ? undefined : index);
  };
  if (donut !== undefined) {
    for (const [index, slice] of donut.slices) {
      slice.addEventListener('click', () => {
        toggle(index);
      });
    }
    donut.hole.addEventListener('click', () => {
      if (selected !== undefined) select(undefined);
    });
    root.append(donut.svg, paragraph(doc, messages.chartTapHint));
  }
  const legend = doc.createElement('ul');
  payload.lines.forEach(([name, , label], index) => {
    const item = doc.createElement('li');
    item.style.minHeight = ROW_MIN_HEIGHT;
    const swatch = svgNode(doc, 'svg', { width: '12', height: '12', viewBox: '0 0 12 12' });
    swatch.append(
      svgNode(doc, 'rect', { width: '12', height: '12', fill: colours[index] ?? NEUTRAL }),
    );
    const text = doc.createElement('span');
    text.textContent = ` ${name}: ${label}`;
    item.append(swatch, text);
    item.addEventListener('click', () => {
      toggle(index);
    });
    items.push(item);
    legend.append(item);
  });
  root.append(legend);
  for (const line of payload.unconverted) root.append(paragraph(doc, line));
}

// The drawn donut and the parts a selection changes: each slice by its line's index, the hole's
// tap target, and the two centre text lines.
interface Donut<N> {
  readonly svg: N;
  readonly slices: ReadonlyMap<number, N>;
  readonly hole: N;
  readonly centre: readonly [top: N, bottom: N];
}

// Shows line `index` in the centre and dims every other slice, or with no index, the total.
function inspect<N extends ChartNode<N>>(
  donut: Donut<N>,
  payload: ChartPayload,
  index: number | undefined,
): void {
  for (const [i, slice] of donut.slices) {
    slice.setAttribute('opacity', index === undefined || i === index ? '1' : DIMMED_OPACITY);
  }
  const line = index === undefined ? undefined : payload.lines[index];
  const [top, bottom] = donut.centre;
  if (line === undefined) {
    setCentre(top, payload.totalLabel, CENTRE_FONT);
    setCentre(bottom, messages.chartTotalCaption, CAPTION_FONT);
  } else {
    setCentre(top, shortName(line[0]), CENTRE_FONT);
    setCentre(bottom, line[2], CENTRE_FONT);
  }
}

// A name cut to NAME_FIT characters, trailing spaces trimmed, plus «…». String handling only.
function shortName(name: string): string {
  const chars = Array.from(name);
  return chars.length > NAME_FIT ? `${chars.slice(0, NAME_FIT).join('').trimEnd()}…` : name;
}

// One annular slice per line with a positive amount, angles in proportion to the amounts, and
// the total in the hole. Floats here are geometry only; no amount shown comes from them.
// Undefined when no line is positive.
function drawDonut<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  payload: ChartPayload,
  colours: readonly string[],
  theme: ChartTheme,
): Donut<N> | undefined {
  const slices = payload.lines
    .map(([, amountMinor], index) => ({ index, amountMinor, colour: colours[index] ?? NEUTRAL }))
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
  const paths = new Map<number, N>();
  if (slices.length === 1) {
    const only = slices[0];
    if (only !== undefined) {
      const attributes = { d: ring(), 'fill-rule': 'evenodd', fill: only.colour, opacity: '1' };
      paths.set(only.index, svgNode(doc, 'path', attributes));
    }
  } else {
    let before = 0;
    for (const slice of slices) {
      const start = (before / whole) * 2 * Math.PI;
      before += slice.amountMinor;
      const end = (before / whole) * 2 * Math.PI;
      const attributes = { d: sector(start, end), fill: slice.colour, opacity: '1', ...edge };
      paths.set(slice.index, svgNode(doc, 'path', attributes));
    }
  }
  svg.append(...paths.values());
  // Catches a tap anywhere in the hole; the text on top lets taps through to it.
  const hole = svgNode(doc, 'circle', {
    r: String(DONUT_INNER),
    fill: 'none',
    'pointer-events': 'all',
  });
  const centre = [centreText(doc, '0.04'), centreText(doc, '0.22')] as const;
  svg.append(hole, ...centre);
  const donut = { svg, slices: paths, hole, centre };
  inspect(donut, payload, undefined);
  return donut;
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

// An empty text line centred in the hole with its baseline at `y`; setCentre fills it.
function centreText<N extends ChartNode<N>>(doc: ChartDocument<N>, y: string): N {
  return svgNode(doc, 'text', {
    x: '0',
    y,
    'text-anchor': 'middle',
    fill: 'currentColor',
    'pointer-events': 'none',
  });
}

// Sets a centre line through `textContent`. Past CENTRE_FIT characters it is squeezed to
// CENTRE_WIDTH so it can't run over the ring.
function setCentre<N extends ChartNode<N>>(node: N, value: string, fontSize: string): void {
  node.textContent = value;
  node.setAttribute('font-size', fontSize);
  if (Array.from(value).length > CENTRE_FIT) {
    node.setAttribute('textLength', CENTRE_WIDTH);
    node.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  } else {
    node.removeAttribute('textLength');
    node.removeAttribute('lengthAdjust');
  }
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
