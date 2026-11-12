// What a widget program draws (ADR-0053): its chatData, a versioned positional JSON array of at
// most 1024 UTF-8 bytes, which widgets/src/ reads back. Amounts are integer minor units for
// geometry, each next to a label the messages module already formatted, so a program does no
// money formatting or arithmetic. Aggregates only, never an individual expense. Each shape's
// version bumps on any change to it; a program shows its "update" glyph on a version it doesn't
// know.

export const WIDGET_DATA_VERSION = 1;

// Telegram's cap on chatData and on an answer to a widget query, in UTF-8 bytes.
export const WIDGET_DATA_BUDGET = 1024;

// The most legend rows a donut shows, the fold line included.
export const DONUT_ROWS = 8;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// One donut line: its label, its amount in minor units, that amount formatted, and the token a
// tap on it requests, '' for a line with nothing behind it.
export type DonutLine = readonly [label: string, minor: number, amount: string, token: string];

// [1, title, total, drill, lines, extra, retry]. `drill` prefixes a line's token in its request,
// '' when no line can be tapped; `extra` is a line under the legend, '' for none; `retry` is the
// text a failed request shows.
export type DonutData = readonly [
  v: typeof WIDGET_DATA_VERSION,
  title: string,
  total: string,
  drill: string,
  lines: readonly DonutLine[],
  extra: string,
  retry: string,
];

export interface DonutInput {
  readonly title: string;
  readonly total: string;
  readonly drill: string;
  // Largest first.
  readonly lines: readonly DonutLine[];
  readonly extra: string;
  readonly retry: string;
}

// The line the smallest lines fold into: its label and its amount's formatter.
export interface WidgetFold {
  readonly name: string;
  readonly amount: (minor: number) => string;
}

// The donut's chatData. The lines are cut to DONUT_ROWS: past it, the smallest fold into one
// `fold` line whose minor units are the exact sum of the lines it replaced and whose token is ''.
// Over `budget` bytes, more lines fold, one at a time. Folding a single line would only rename
// it, so the fold always takes two or more. Undefined when nothing fits.
export function encodeDonut(
  input: DonutInput,
  fold: WidgetFold,
  budget: number = WIDGET_DATA_BUDGET,
): string | undefined {
  const { lines } = input;
  const candidates: (readonly DonutLine[])[] = lines.length <= DONUT_ROWS ? [lines] : [];
  for (let kept = Math.min(lines.length, DONUT_ROWS) - 1; kept >= 0; kept--) {
    const rest = lines.slice(kept);
    if (rest.length < 2) continue;
    const minor = rest.reduce((sum, line) => {
      const next = sum + line[1];
      if (!Number.isSafeInteger(next)) throw new RangeError('fold exceeds the safe integer range');
      return next;
    }, 0);
    candidates.push([...lines.slice(0, kept), [fold.name, minor, fold.amount(minor), '']]);
  }
  for (const shown of candidates) {
    const data: DonutData = [
      WIDGET_DATA_VERSION,
      input.title,
      input.total,
      input.drill,
      shown,
      input.extra,
      input.retry,
    ];
    const json = JSON.stringify(data);
    if (utf8Bytes(json) <= budget) return json;
  }
  return undefined;
}

// One point of a drill-down: its period's label, the amount in minor units, and that amount
// formatted.
export type DrillPoint = readonly [label: string, minor: number, amount: string];

// The answer to a donut's drill-down request: [1, title, points, back], the points oldest first
// and `back` the label of the button that returns to the donut; or [1, error], an error's text
// already worded.
export type DrillAnswer =
  | readonly [
      v: typeof WIDGET_DATA_VERSION,
      title: string,
      points: readonly DrillPoint[],
      back: string,
    ]
  | readonly [v: typeof WIDGET_DATA_VERSION, error: string];

export interface DrillInput {
  readonly title: string;
  // Oldest first.
  readonly points: readonly DrillPoint[];
  readonly back: string;
}

// A drill-down answer. Over `budget` bytes the oldest points go first, the newest always kept.
export function encodeDrill(input: DrillInput, budget: number = WIDGET_DATA_BUDGET): string {
  let points = input.points;
  for (;;) {
    const answer: DrillAnswer = [WIDGET_DATA_VERSION, input.title, points, input.back];
    const json = JSON.stringify(answer);
    if (utf8Bytes(json) <= budget || points.length <= 1) return json;
    points = points.slice(1);
  }
}

export function encodeDrillError(error: string): string {
  const answer: DrillAnswer = [WIDGET_DATA_VERSION, error];
  return JSON.stringify(answer);
}

// One bar of the `days` program: its label, its amount in minor units, and that amount formatted.
export type BarRow = readonly [label: string, minor: number, amount: string];

// [1, title, rows, highlight, extra]: horizontal bars oldest first, `highlight` the index of the
// row drawn as current (-1 for none), `extra` a line under them ('' for none).
export type BarsData = readonly [
  v: typeof WIDGET_DATA_VERSION,
  title: string,
  rows: readonly BarRow[],
  highlight: number,
  extra: string,
];

export interface BarsInput {
  readonly title: string;
  // Oldest first.
  readonly rows: readonly BarRow[];
  readonly highlight: number;
  readonly extra: string;
}

// The `days` program's chatData. Over `budget` bytes the oldest rows go first, the highlight
// following its row, the newest row always kept.
export function encodeBars(input: BarsInput, budget: number = WIDGET_DATA_BUDGET): string {
  let dropped = 0;
  for (;;) {
    const rows = input.rows.slice(dropped);
    const data: BarsData = [
      WIDGET_DATA_VERSION,
      input.title,
      rows,
      input.highlight - dropped,
      input.extra,
    ];
    const json = JSON.stringify(data);
    if (utf8Bytes(json) <= budget || rows.length <= 1) return json;
    dropped++;
  }
}

// [1, title, status, remaining, limit, days, extra]: a budget period's burn-down. `remaining` is
// the limit minus the spend through each elapsed day, day 1 first, negative once overspent;
// `limit` is the ideal line's start, which falls to 0 at the end of day `days`. `status` is the
// line above the chart, `extra` the one under it.
export type BurndownData = readonly [
  v: typeof WIDGET_DATA_VERSION,
  title: string,
  status: string,
  remaining: readonly number[],
  limit: number,
  days: number,
  extra: string,
];

export interface BurndownInput {
  readonly title: string;
  readonly status: string;
  readonly limitMinor: number;
  readonly days: number;
  // The cumulative spend at the end of each elapsed day, day 1 first.
  readonly spent: readonly number[];
  readonly extra: string;
}

// The `burndown` program's chatData; undefined over `budget` bytes.
export function encodeBurndown(
  input: BurndownInput,
  budget: number = WIDGET_DATA_BUDGET,
): string | undefined {
  const data: BurndownData = [
    WIDGET_DATA_VERSION,
    input.title,
    input.status,
    input.spent.map((spent) => input.limitMinor - spent),
    input.limitMinor,
    input.days,
    input.extra,
  ];
  const json = JSON.stringify(data);
  return utf8Bytes(json) <= budget ? json : undefined;
}
