import { deflateSync } from 'node:zlib';
import { sharesOf } from './shares.js';

// The chart payload (ADR-0025, ADR-0045): what a «📈 Диаграмма» button hands the Mini App page,
// in its URL fragment as `#z=<base64url(deflate(UTF-8 JSON))>`. A versioned contract:
// webapp/src/payload.ts mirrors these types and decodes them. A payload is a title and a list of
// sections the page draws in order, skipping a kind it doesn't know. Amounts are integer minor
// units for geometry, each next to a label the bot's messages module already formatted, so the
// page does no money formatting or arithmetic. Aggregates only, never an individual expense.

export const CHART_PAYLOAD_VERSION = 2;

// The most characters the `z` value may hold. Telegram carries the button URL to the client,
// which opens it with its own launch parameters added; 2048 is the smallest size measured.
export const CHART_PAYLOAD_BUDGET = 2048;

// One pie slice: the category name, its amount in minor units, its formatted amount, its
// formatted share of the pie, and its formatted change against the previous period when known.
export type ChartLine = readonly [
  name: string,
  amountMinor: number,
  label: string,
  share: string,
  change?: string,
];

// One trend bar: the period's name, its converted total in minor units, and that total formatted.
export type TrendBar = readonly [periodLabel: string, totalMinor: number, label: string];

export interface PieSection {
  readonly k: 'pie';
  // ISO-4217: the ledger's default currency, the block every converted expense sits in.
  readonly currency: string;
  // The sum of the lines' amounts, an integer in minor units.
  readonly totalMinor: number;
  readonly totalLabel: string;
  // The total's change with the basis it is against, «↑11% к сентябрю»; absent when there is no
  // change to show or it was shed.
  readonly totalChange?: string;
  // Largest first, as the text screen lists them.
  readonly lines: readonly ChartLine[];
  // One formatted line per currency with no rate, never added to the pie.
  readonly unconverted: readonly string[];
}

export interface TrendSection {
  readonly k: 'trend';
  // The shown period and the ones before it, oldest first.
  readonly bars: readonly TrendBar[];
}

// A period's spending pace: cumulative spend by day, each series an integer in minor units at the
// end of each day, day 1 first. Day d of `previous` is drawn against day d of `current`.
export interface PaceSection {
  readonly k: 'pace';
  // The period's length in days.
  readonly days: number;
  // One point per elapsed day, through today or the period's end.
  readonly current: readonly number[];
  // The previous period, all its days.
  readonly previous?: readonly number[];
  // A budget's limit and its formatted caption; the allowance line runs from 0 to it.
  readonly limit?: readonly [limitMinor: number, label: string];
  // The current series' caption, then the previous series' or, on a budget chart, the allowance
  // line's.
  readonly captions: readonly [current: string, second?: string];
}

// One point of a category's history: its converted total in a period, in minor units, and that
// total formatted.
export type CatTrendPoint = readonly [amountMinor: number, label: string];

// Each pie line's totals over the shown period and the ones before it, the panel the page opens
// under a selected legend row. A line with no series has no history to show.
export interface CatTrendSection {
  readonly k: 'catTrend';
  // The panel's caption, «Последние 6 месяцев».
  readonly caption: string;
  // The periods' names, oldest first.
  readonly periods: readonly string[];
  // `line` is an index into the pie section's lines; the points are one per period, oldest first.
  readonly series: readonly (readonly [line: number, points: readonly CatTrendPoint[]])[];
}

// One bar of a bars section: its label, its amount in minor units, null for a row drawn with no
// bar, and its formatted text.
export type BarsRow = readonly [label: string, amountMinor: number | null, text: string];

// Labelled horizontal bars on one axis, in one currency, under a caption.
export interface BarsSection {
  readonly k: 'bars';
  readonly caption: string;
  // Oldest first.
  readonly rows: readonly BarsRow[];
  // Lines listed under the bars as text, never drawn: amounts in other currencies.
  readonly notes?: readonly string[];
}

export type ChartSection = PieSection | PaceSection | TrendSection | CatTrendSection | BarsSection;

export interface ChartPayloadV2 {
  readonly v: typeof CHART_PAYLOAD_VERSION;
  // The period's title, e.g. «Сентябрь 2026».
  readonly title: string;
  readonly sections: readonly ChartSection[];
}

// What the messages module formats: the pie's fields, the pace, the trend bars and the categories'
// histories. A trend with no bars, and a catTrend with no series, are left out of the payload.
export interface ChartInput {
  readonly title: string;
  readonly currency: string;
  readonly totalLabel: string;
  readonly totalChange?: string;
  readonly lines: readonly ChartLine[];
  readonly unconverted: readonly string[];
  readonly pace?: PaceSection;
  readonly trend?: readonly TrendBar[];
  readonly catTrend?: CatTrendSection;
}

// The line the smallest categories fold into when the payload is over budget: its name, and the
// formatters for its amount and its share, all from the messages module.
export interface ChartFold {
  readonly name: string;
  readonly label: (amountMinor: number) => string;
  readonly share: (percent: number, amountMinor: number) => string;
}

// The payload for `input`: a pie section whose `totalMinor` is the exact integer sum of the
// lines, then the pace section when there is one, then a trend section when there are bars, then
// the catTrend section when it has a series.
export function chartPayload(input: ChartInput): ChartPayloadV2 {
  const pie: PieSection = {
    k: 'pie',
    currency: input.currency,
    totalMinor: totalOf(input.lines),
    totalLabel: input.totalLabel,
    ...(input.totalChange === undefined ? {} : { totalChange: input.totalChange }),
    lines: input.lines,
    unconverted: input.unconverted,
  };
  const trend = input.trend ?? [];
  const { catTrend } = input;
  return {
    v: CHART_PAYLOAD_VERSION,
    title: input.title,
    sections: [
      pie,
      ...(input.pace === undefined ? [] : [input.pace]),
      ...(trend.length === 0 ? [] : [{ k: 'trend', bars: trend } as const]),
      ...(catTrend === undefined || catTrend.series.length === 0 ? [] : [catTrend]),
    ],
  };
}

// The `z` value of the button URL's fragment: zlib deflate of the payload's UTF-8 JSON, as
// base64url (unpadded), so it holds no `&`, `=` or `#` that would split Telegram's launch
// parameters. Over `budget`, detail is shed in order (ADR-0045): the catTrend series one by one,
// the smallest pie line's first, which with the last one drops the section, then every change
// label at once, the total's included, then the pace section's previous series with its caption,
// then the pace section, then the oldest trend bars one by one, which with the last one drops the
// trend section, then the smallest lines fold into one `fold` line, more of them each try. No pie
// line folds while a catTrend series is left, so the series' line indices hold. Each step is
// compressed again, since how well a payload compresses depends on its content. Undefined when
// nothing fits.
export function encodeChartPayload(
  input: ChartInput,
  fold: ChartFold,
  budget: number = CHART_PAYLOAD_BUDGET,
): string | undefined {
  for (const candidate of shedding(input, fold)) {
    const z = encode(chartPayload(candidate));
    if (z.length <= budget) return z;
  }
  return undefined;
}

// The `z` value of a payload titled `title` holding the one pace section `pace`, as
// encodeChartPayload encodes it. Nothing is shed: undefined over `budget`.
export function encodePacePayload(
  title: string,
  pace: PaceSection,
  budget: number = CHART_PAYLOAD_BUDGET,
): string | undefined {
  const z = encode({ v: CHART_PAYLOAD_VERSION, title, sections: [pace] });
  return z.length <= budget ? z : undefined;
}

// A payload of bars sections: `primary`, then `secondary` when there is one.
export interface BarsInput {
  readonly title: string;
  readonly primary: BarsSection;
  readonly secondary?: BarsSection;
}

// The `z` value of a payload titled `input.title` holding its bars sections, as
// encodeChartPayload encodes it. Over `budget`, the secondary section goes first, then the
// primary's oldest rows one by one, its last row kept. Undefined when nothing fits.
export function encodeBarsPayload(
  input: BarsInput,
  budget: number = CHART_PAYLOAD_BUDGET,
): string | undefined {
  const { title, primary, secondary } = input;
  const candidates: (readonly BarsSection[])[] =
    secondary === undefined ? [] : [[primary, secondary]];
  for (let dropped = 0; dropped < Math.max(primary.rows.length, 1); dropped++) {
    candidates.push([{ ...primary, rows: primary.rows.slice(dropped) }]);
  }
  for (const sections of candidates) {
    const z = encode({ v: CHART_PAYLOAD_VERSION, title, sections });
    if (z.length <= budget) return z;
  }
  return undefined;
}

function encode(payload: ChartPayloadV2): string {
  return deflateSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64url');
}

// `input` itself, then each step of shedding, every one smaller than the one before.
function* shedding(input: ChartInput, fold: ChartFold): Generator<ChartInput> {
  yield input;
  const { catTrend } = input;
  if (catTrend !== undefined) {
    // Largest pie line first; a tie keeps the pie's order.
    const amountOf = (line: number) => input.lines[line]?.[1] ?? 0;
    const bySize = [...catTrend.series].sort(([a], [b]) => amountOf(b) - amountOf(a) || a - b);
    for (let kept = bySize.length - 1; kept >= 0; kept--) {
      const series = catTrend.series.filter((entry) => bySize.indexOf(entry) < kept);
      yield { ...input, catTrend: { ...catTrend, series } };
    }
  }
  const bare: ChartInput = {
    title: input.title,
    currency: input.currency,
    totalLabel: input.totalLabel,
    lines: input.lines.map(([name, amountMinor, label, share]) => [
      name,
      amountMinor,
      label,
      share,
    ]),
    unconverted: input.unconverted,
  };
  const { pace } = input;
  const trend = input.trend ?? [];
  if (input.totalChange !== undefined || input.lines.some((line) => line[4] !== undefined)) {
    yield { ...bare, ...(pace === undefined ? {} : { pace }), trend };
  }
  if (pace?.previous !== undefined) {
    const current: PaceSection = {
      k: 'pace',
      days: pace.days,
      current: pace.current,
      ...(pace.limit === undefined ? {} : { limit: pace.limit }),
      captions: [pace.captions[0]],
    };
    yield { ...bare, pace: current, trend };
  }
  if (pace !== undefined) yield { ...bare, trend };
  for (let dropped = 1; dropped <= trend.length; dropped++) {
    yield { ...bare, trend: trend.slice(dropped) };
  }
  for (let folded = 1; folded <= bare.lines.length; folded++) {
    yield { ...bare, trend: [], lines: foldSmallest(bare.lines, folded, fold) };
  }
}

// `lines` with its `count` smallest lines summed into one `fold` line, put last. A category
// already named like the fold line joins it, so the name never appears twice. The amounts move
// whole, so the result sums to exactly what `lines` sums to. The fold's share is the sum of the
// folded lines' integer shares, so the shares still sum to 100.
function foldSmallest(
  lines: readonly ChartLine[],
  count: number,
  fold: ChartFold,
): readonly ChartLine[] {
  const bySize = [...lines].sort((a, b) => b[1] - a[1]);
  const kept = bySize.slice(0, bySize.length - count).filter(([name]) => name !== fold.name);
  const folded = lines.flatMap((line, index) => (kept.includes(line) ? [] : [index]));
  if (folded.length === 0) return kept;
  const amounts = lines.map(([, amountMinor]) => amountMinor);
  const shares = totalOf(lines) > 0 ? sharesOf(amounts) : amounts.map(() => 0);
  let amountMinor = 0;
  let percent = 0;
  for (const index of folded) {
    amountMinor += amounts[index] ?? 0;
    percent += shares[index] ?? 0;
  }
  return [
    ...kept,
    [fold.name, amountMinor, fold.label(amountMinor), fold.share(percent, amountMinor)],
  ];
}

function totalOf(lines: readonly ChartLine[]): number {
  let totalMinor = 0;
  for (const [, amountMinor] of lines) {
    totalMinor += amountMinor;
    if (!Number.isSafeInteger(totalMinor)) {
      throw new RangeError('chart total exceeds the safe integer range');
    }
  }
  return totalMinor;
}
