import { drawBars, drawTrend } from './bars.js';
import { drawPace } from './line.js';
import { messages } from './messages.js';
import { paletteFor } from './palette.js';
import {
  canInflate,
  decodeChartPayload,
  payloadParam,
  type BarsSection,
  type CatTrendSection,
  type ChartPayload,
  type PaceSection,
  type PieSection,
  type Section,
  type TrendSection,
} from './payload.js';

export const SVG = 'http://www.w3.org/2000/svg';

// The inline-style properties the chart writes. They go through CSSOM only: the CSP has no
// style-src, so a `style` attribute would be blocked (index.html).
export interface ChartStyle {
  maxWidth: string;
  display: string;
  margin: string;
  minHeight: string;
  fontWeight: string;
  backgroundColor: string;
  color: string;
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
  replaceChildren(...nodes: N[]): void;
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
  readonly button?: string | undefined;
}

// The slice of `Telegram.WebApp` chart mode uses; every member is absent outside Telegram or on
// a client too old for it. `themeParams` is updated in place before `themeChanged` fires.
export interface ChartWebApp {
  readonly themeParams?: {
    readonly bg_color?: string;
    readonly text_color?: string;
    readonly hint_color?: string;
    readonly button_color?: string;
  };
  readonly expand?: () => void;
  readonly onEvent?: (event: 'themeChanged', handler: () => void) => void;
  readonly HapticFeedback?: { readonly selectionChanged?: () => void };
}

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

// What chart mode shows for a hash: the payload's title and sections, or one fallback line.
export type ChartState =
  | { readonly kind: 'chart'; readonly title: string; readonly sections: readonly Section[] }
  | { readonly kind: 'fallback'; readonly line: string };

// Chart mode's entry: expands the sheet, decodes the payload in `hash` once, draws it into
// `root` in the current theme's colours, and redraws it from scratch whenever Telegram's theme
// changes. The CSSOM writes to `root` are allowed by the CSP's missing style-src (index.html).
export async function startChart<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  hash: string,
  webApp: ChartWebApp | undefined,
): Promise<void> {
  webApp?.expand?.();
  doc.title = messages.chartTitle;
  const state = await chartState(hash);
  const draw = () => {
    const params = webApp?.themeParams;
    if (params?.bg_color !== undefined) root.style.backgroundColor = params.bg_color;
    if (params?.text_color !== undefined) root.style.color = params.text_color;
    const theme = { bg: params?.bg_color, hint: params?.hint_color, button: params?.button_color };
    root.replaceChildren();
    drawState(doc, root, state, theme, () => {
      webApp?.HapticFeedback?.selectionChanged?.();
    });
  };
  draw();
  webApp?.onEvent?.('themeChanged', draw);
}

// Chart mode: titles the page and draws the payload in `hash` into `root`. `onSelect` runs on
// every change of the inspected line.
export async function showChart<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  hash: string,
  theme: ChartTheme = {},
  onSelect: () => void = () => {},
): Promise<void> {
  doc.title = messages.chartTitle;
  drawState(doc, root, await chartState(hash), theme, onSelect);
}

// A missing payload shows the open-from-bot line; a `z` payload on a client that can't inflate
// it, the unsupported-client line; a payload the page can't read, the broken-chart line. A v1
// payload is read as a pie section and, when it has bars, a trend section.
export async function chartState(hash: string): Promise<ChartState> {
  const param = payloadParam(hash);
  if (param === undefined) return { kind: 'fallback', line: messages.openFromBot };
  if (param.key === 'z' && !canInflate()) {
    return { kind: 'fallback', line: messages.chartUnsupported };
  }
  const payload = await decodeChartPayload(hash);
  if (payload === undefined) return { kind: 'fallback', line: messages.chartBroken };
  return { kind: 'chart', title: payload.title, sections: sectionsOf(payload) };
}

function sectionsOf(payload: ChartPayload): readonly Section[] {
  if (payload.v === 2) return payload.sections;
  const pie: PieSection = {
    k: 'pie',
    currency: payload.currency,
    totalMinor: payload.totalMinor,
    totalLabel: payload.totalLabel,
    lines: payload.lines,
    unconverted: payload.unconverted,
  };
  return payload.trend === undefined ? [pie] : [pie, { k: 'trend', bars: payload.trend }];
}

// The title, then each section in order: a pie, a pace, a trend with bars, or a bars section. A
// section of a kind the page doesn't know draws nothing.
function drawState<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  state: ChartState,
  theme: ChartTheme,
  onSelect: () => void,
): void {
  if (state.kind === 'fallback') {
    root.append(paragraph(doc, state.line));
    return;
  }
  const title = doc.createElement('h1');
  title.textContent = state.title;
  root.append(title);
  const catTrend = state.sections.find(isCatTrend);
  for (const section of state.sections) {
    if (isPie(section)) drawPie(doc, root, state.title, section, catTrend, theme, onSelect);
    else if (isPace(section)) root.append(...drawPace(doc, section, theme));
    else if (isTrend(section) && section.bars.length > 0) {
      root.append(drawTrend(doc, section.bars, theme));
    } else if (isBars(section)) root.append(...drawBars(doc, section, theme));
  }
}

function isBars(section: Section): section is BarsSection {
  return section.k === 'bars';
}

function isPie(section: Section): section is PieSection {
  return section.k === 'pie';
}

function isPace(section: Section): section is PaceSection {
  return section.k === 'pace';
}

function isTrend(section: Section): section is TrendSection {
  return section.k === 'trend';
}

function isCatTrend(section: Section): section is CatTrendSection {
  return section.k === 'catTrend';
}

// The total, the donut of the converted block with its tap hint and legend, then one line per
// currency with no rate, which is never drawn. A legend row reads «name: amount · share · change»,
// its parts the payload's own strings, each present only when sent. With no line selected, the
// centre shows the total over its change and basis, or over «Всего» without one. Tapping a slice
// or a legend row inspects that line; tapping it again, or the hole, goes back to the total. With a
// catTrend section, the selected line's history panel opens as the legend item right after its
// row (historyPanel). The selection lives in this closure only: it is never stored or sent.
function drawPie<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  root: N,
  title: string,
  payload: PieSection,
  catTrend: CatTrendSection | undefined,
  theme: ChartTheme,
  onSelect: () => void,
): void {
  root.append(paragraph(doc, payload.totalLabel));
  // A line past the palette's end, or with nothing spent, is in the theme's hint grey.
  const palette = paletteFor(theme.bg);
  const colours = payload.lines.map(
    ([, amountMinor], index) =>
      (amountMinor > 0 ? palette[index] : undefined) ?? theme.hint ?? NEUTRAL,
  );
  const donut = drawDonut(doc, title, payload, colours, theme);
  const legend = doc.createElement('ul');
  const items: N[] = [];
  let selected: number | undefined;
  const select = (index: number | undefined) => {
    selected = index;
    if (donut !== undefined) inspect(donut, payload, index);
    items.forEach((item, i) => (item.style.fontWeight = i === index ? 'bold' : ''));
    const line = index === undefined ? undefined : payload.lines[index];
    if (catTrend === undefined || index === undefined || line === undefined) {
      legend.replaceChildren(...items);
    } else {
      const panel = historyPanel(doc, line[0], index, catTrend, theme);
      legend.replaceChildren(...items.slice(0, index + 1), panel, ...items.slice(index + 1));
    }
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
  payload.lines.forEach(([name, , label, share, change], index) => {
    const item = doc.createElement('li');
    item.style.minHeight = ROW_MIN_HEIGHT;
    const swatch = svgNode(doc, 'svg', { width: '12', height: '12', viewBox: '0 0 12 12' });
    swatch.append(
      svgNode(doc, 'rect', { width: '12', height: '12', fill: colours[index] ?? NEUTRAL }),
    );
    const text = doc.createElement('span');
    const parts = [label, share, change].filter((part) => part !== undefined);
    text.textContent = ` ${name}: ${parts.join(' · ')}`;
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

// The history panel of pie line `index`, named `name`: a heading of the name, then the section's
// caption over one bar per period (drawTrend), or, for a line with no series (the fold line, or one
// shed for size), the no-history line and no bars.
function historyPanel<N extends ChartNode<N>>(
  doc: ChartDocument<N>,
  name: string,
  index: number,
  catTrend: CatTrendSection,
  theme: ChartTheme,
): N {
  const panel = doc.createElement('li');
  const heading = doc.createElement('h2');
  heading.textContent = name;
  panel.append(heading);
  const points = catTrend.series.find(([line]) => line === index)?.[1];
  if (points === undefined) {
    panel.append(paragraph(doc, messages.chartNoHistory));
    return panel;
  }
  const bars = points.map(
    ([amountMinor, label], i) => [catTrend.periods[i] ?? '', amountMinor, label] as const,
  );
  panel.append(paragraph(doc, catTrend.caption), drawTrend(doc, bars, theme));
  return panel;
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
  payload: PieSection,
  index: number | undefined,
): void {
  for (const [i, slice] of donut.slices) {
    slice.setAttribute('opacity', index === undefined || i === index ? '1' : DIMMED_OPACITY);
  }
  const line = index === undefined ? undefined : payload.lines[index];
  const [top, bottom] = donut.centre;
  if (line === undefined) {
    setCentre(top, payload.totalLabel, CENTRE_FONT);
    setCentre(bottom, payload.totalChange ?? messages.chartTotalCaption, CAPTION_FONT);
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
  title: string,
  payload: PieSection,
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
    'aria-label': `${title}: ${payload.totalLabel}`,
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
