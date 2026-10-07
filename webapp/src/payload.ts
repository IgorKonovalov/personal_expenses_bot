// The chart payload the bot puts in the button URL's fragment (ADR-0025, ADR-0045). Version 2 is
// `#z=<base64url(deflate(UTF-8 JSON))>`, a title and sections drawn in order; version 1,
// `#d=<base64url JSON>`, is still read for buttons sent before it. These types mirror the bot's
// src/domain/chartPayload.ts, which the page can't import: it is built alone and shares no code
// with the bot.

// A pie line: name, amount in minor units, formatted amount, then in v2 the formatted share and,
// when the bot sent one, the formatted change against the previous period.
export type ChartLine = readonly [
  name: string,
  amountMinor: number,
  label: string,
  share?: string,
  change?: string,
];

// One trend bar: the period's name, its total in minor units, and that total formatted.
export type TrendBar = readonly [periodLabel: string, totalMinor: number, label: string];

export interface ChartPayloadV1 {
  readonly v: 1;
  readonly title: string;
  readonly currency: string;
  // The integer sum of the lines' amounts, in minor units.
  readonly totalMinor: number;
  readonly totalLabel: string;
  readonly lines: readonly ChartLine[];
  // One formatted line per currency with no rate.
  readonly unconverted: readonly string[];
  // The shown period and the ones before it, oldest first; absent when the bot left none.
  readonly trend?: readonly TrendBar[];
}

export interface PieSection {
  readonly k: 'pie';
  readonly currency: string;
  // The integer sum of the lines' amounts, in minor units.
  readonly totalMinor: number;
  readonly totalLabel: string;
  // The total's change with its basis, «↑11% к сентябрю»: the centre's caption when present.
  readonly totalChange?: string;
  readonly lines: readonly ChartLine[];
  // One formatted line per currency with no rate.
  readonly unconverted: readonly string[];
}

export interface TrendSection {
  readonly k: 'trend';
  // Oldest first.
  readonly bars: readonly TrendBar[];
}

// A period's cumulative spend by day, in minor units, day 1 first; day d of `previous` is drawn
// against day d of `current`.
export interface PaceSection {
  readonly k: 'pace';
  // The period's length in days.
  readonly days: number;
  // One point per elapsed day.
  readonly current: readonly number[];
  // The previous period, all its days.
  readonly previous?: readonly number[];
  // A budget's limit and its formatted caption: the allowance line runs from 0 to it.
  readonly limit?: readonly [limitMinor: number, label: string];
  // The current series' caption, then the previous series' or, with a limit, the allowance
  // line's.
  readonly captions: readonly [current: string, second?: string];
}

// One point of a category's history: its total in a period, in minor units, and that total
// formatted.
export type CatTrendPoint = readonly [amountMinor: number, label: string];

// Each pie line's totals over the shown period and the ones before it: the panel under a selected
// legend row. A line with no series has no history here.
export interface CatTrendSection {
  readonly k: 'catTrend';
  // The panel's caption, «Последние 6 месяцев».
  readonly caption: string;
  // The periods' names, oldest first.
  readonly periods: readonly string[];
  // `line` indexes the pie section's lines; one point per period, oldest first.
  readonly series: readonly (readonly [line: number, points: readonly CatTrendPoint[]])[];
}

// A section of a kind this page doesn't draw: kept by the decoder, skipped by the page.
export interface UnknownSection {
  readonly k: string;
}

export type Section = PieSection | PaceSection | TrendSection | CatTrendSection | UnknownSection;

export interface ChartPayloadV2 {
  readonly v: 2;
  readonly title: string;
  readonly sections: readonly Section[];
}

export type ChartPayload = ChartPayloadV1 | ChartPayloadV2;

// The raw payload value from the fragment and its key, `z` before `d`. Telegram appends its own
// launch parameters (`tgWebAppData` and others), so the key is read as one among them.
export function payloadParam(hash: string): { key: 'z' | 'd'; value: string } | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const z = params.get('z');
  if (z !== null) return { key: 'z', value: z };
  const d = params.get('d');
  return d === null ? undefined : { key: 'd', value: d };
}

// Whether this client can inflate a `z` payload.
export function canInflate(): boolean {
  return typeof DecompressionStream === 'function';
}

// The payload in `hash`, or undefined for a missing value, broken base64url, deflate or JSON, an
// unknown version, or a known field of the wrong shape, including pie lines that don't sum to
// their `totalMinor`. A v2 section of an unknown kind is kept as it came.
export async function decodeChartPayload(hash: string): Promise<ChartPayload | undefined> {
  const param = payloadParam(hash);
  if (param === undefined || !/^[A-Za-z0-9_-]+$/.test(param.value)) return undefined;
  let value: unknown;
  try {
    const binary = atob(param.value.replace(/-/g, '+').replace(/_/g, '/'));
    let bytes: Uint8Array<ArrayBuffer> = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (param.key === 'z') bytes = await inflate(bytes);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (param.key === 'z') return isPayloadV2(value) ? value : undefined;
  return isPayloadV1(value) ? value : undefined;
}

// zlib-format deflate undone; rejects on bytes that aren't valid deflate.
async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isPayloadV1(value: unknown): value is ChartPayloadV1 {
  if (!isRecord(value)) return false;
  return (
    value['v'] === 1 &&
    typeof value['title'] === 'string' &&
    typeof value['currency'] === 'string' &&
    typeof value['totalLabel'] === 'string' &&
    isStrings(value['unconverted']) &&
    (value['trend'] === undefined || isBars(value['trend'])) &&
    linesSumTo(value['lines'], value['totalMinor'], 3)
  );
}

function isPayloadV2(value: unknown): value is ChartPayloadV2 {
  if (!isRecord(value)) return false;
  return (
    value['v'] === 2 &&
    typeof value['title'] === 'string' &&
    Array.isArray(value['sections']) &&
    value['sections'].every(isSection)
  );
}

// A section with a string kind; a pie, a pace, a trend or a catTrend must also have its own shape.
function isSection(value: unknown): value is Section {
  if (!isRecord(value) || typeof value['k'] !== 'string') return false;
  switch (value['k']) {
    case 'pie':
      return (
        typeof value['currency'] === 'string' &&
        typeof value['totalLabel'] === 'string' &&
        (value['totalChange'] === undefined || typeof value['totalChange'] === 'string') &&
        isStrings(value['unconverted']) &&
        linesSumTo(value['lines'], value['totalMinor'], 4, 5)
      );
    case 'trend':
      return isBars(value['bars']);
    case 'pace':
      return isPace(value);
    case 'catTrend':
      return isCatTrend(value);
    default:
      return true;
  }
}

// A string caption, string period names, and series of a non-negative whole line index with one
// point per period, each a safe integer and a string.
function isCatTrend(value: Record<string, unknown>): boolean {
  const periods = value['periods'];
  const series = value['series'];
  return (
    typeof value['caption'] === 'string' &&
    isStrings(periods) &&
    Array.isArray(series) &&
    series.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        Number.isSafeInteger(entry[0]) &&
        typeof entry[0] === 'number' &&
        entry[0] >= 0 &&
        Array.isArray(entry[1]) &&
        entry[1].length === periods.length &&
        entry[1].every(
          (point) =>
            Array.isArray(point) &&
            point.length === 2 &&
            Number.isSafeInteger(point[0]) &&
            typeof point[1] === 'string',
        ),
    )
  );
}

// A positive whole number of days, a current series of at most that many safe integers, an
// optional previous series of safe integers, an optional limit of a positive safe integer and a
// string, and one or two string captions.
function isPace(value: Record<string, unknown>): boolean {
  const days = value['days'];
  const current = value['current'];
  const previous = value['previous'];
  const limit = value['limit'];
  const captions = value['captions'];
  return (
    Number.isSafeInteger(days) &&
    typeof days === 'number' &&
    days > 0 &&
    isAmounts(current) &&
    current.length <= days &&
    (previous === undefined || isAmounts(previous)) &&
    (limit === undefined ||
      (Array.isArray(limit) &&
        limit.length === 2 &&
        Number.isSafeInteger(limit[0]) &&
        typeof limit[0] === 'number' &&
        limit[0] > 0 &&
        typeof limit[1] === 'string')) &&
    isStrings(captions) &&
    captions.length >= 1 &&
    captions.length <= 2
  );
}

function isAmounts(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isSafeInteger(item));
}

// Pie lines of `min` to `max` elements, every one past the third a string, whose amounts sum to
// `totalMinor`, a safe integer.
function linesSumTo(lines: unknown, totalMinor: unknown, min: number, max = min): boolean {
  if (!Array.isArray(lines) || !Number.isSafeInteger(totalMinor)) return false;
  let sum = 0;
  for (const line of lines) {
    if (!isTriple(line) || line.length < min || line.length > max) return false;
    if (line.slice(3).some((extra) => typeof extra !== 'string')) return false;
    sum += line[1];
  }
  return sum === totalMinor;
}

function isBars(value: unknown): value is TrendBar[] {
  return Array.isArray(value) && value.every((bar) => isTriple(bar) && bar.length === 3);
}

// An array starting with a string, a safe integer and a string.
function isTriple(value: unknown): value is readonly [string, number, string, ...unknown[]] {
  return (
    Array.isArray(value) &&
    typeof value[0] === 'string' &&
    Number.isSafeInteger(value[1]) &&
    typeof value[2] === 'string'
  );
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
