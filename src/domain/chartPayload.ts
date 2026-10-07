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

// One pie slice: the category name, its amount in minor units, its formatted amount, and its
// formatted share of the pie.
export type ChartLine = readonly [name: string, amountMinor: number, label: string, share: string];

// One trend bar: the period's name, its converted total in minor units, and that total formatted.
export type TrendBar = readonly [periodLabel: string, totalMinor: number, label: string];

export interface PieSection {
  readonly k: 'pie';
  // ISO-4217: the ledger's default currency, the block every converted expense sits in.
  readonly currency: string;
  // The sum of the lines' amounts, an integer in minor units.
  readonly totalMinor: number;
  readonly totalLabel: string;
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

export type ChartSection = PieSection | TrendSection;

export interface ChartPayloadV2 {
  readonly v: typeof CHART_PAYLOAD_VERSION;
  // The period's title, e.g. «Сентябрь 2026».
  readonly title: string;
  readonly sections: readonly ChartSection[];
}

// What the messages module formats: the pie's fields, and the trend bars. A trend with no bars
// is left out of the payload.
export interface ChartInput {
  readonly title: string;
  readonly currency: string;
  readonly totalLabel: string;
  readonly lines: readonly ChartLine[];
  readonly unconverted: readonly string[];
  readonly trend?: readonly TrendBar[];
}

// The line the smallest categories fold into when the payload is over budget: its name, and the
// formatters for its amount and its share, all from the messages module.
export interface ChartFold {
  readonly name: string;
  readonly label: (amountMinor: number) => string;
  readonly share: (percent: number, amountMinor: number) => string;
}

// The payload for `input`: a pie section whose `totalMinor` is the exact integer sum of the
// lines, then a trend section when there are bars.
export function chartPayload(input: ChartInput): ChartPayloadV2 {
  const pie: PieSection = {
    k: 'pie',
    currency: input.currency,
    totalMinor: totalOf(input.lines),
    totalLabel: input.totalLabel,
    lines: input.lines,
    unconverted: input.unconverted,
  };
  const trend = input.trend ?? [];
  return {
    v: CHART_PAYLOAD_VERSION,
    title: input.title,
    sections: trend.length === 0 ? [pie] : [pie, { k: 'trend', bars: trend }],
  };
}

// The `z` value of the button URL's fragment: zlib deflate of the payload's UTF-8 JSON, as
// base64url (unpadded), so it holds no `&`, `=` or `#` that would split Telegram's launch
// parameters. Over `budget`, detail is shed in order (ADR-0045): the oldest trend bars one by one,
// which with the last one drops the trend section, then the smallest lines fold into one `fold`
// line, more of them each try. Each step is compressed again, since how well a payload
// compresses depends on its content. Undefined when nothing fits.
export function encodeChartPayload(
  input: ChartInput,
  fold: ChartFold,
  budget: number = CHART_PAYLOAD_BUDGET,
): string | undefined {
  for (const candidate of shedding(input, fold)) {
    const encoded = deflateSync(Buffer.from(JSON.stringify(chartPayload(candidate)), 'utf8'));
    const z = encoded.toString('base64url');
    if (z.length <= budget) return z;
  }
  return undefined;
}

// `input` itself, then each step of shedding, every one smaller than the one before.
function* shedding(input: ChartInput, fold: ChartFold): Generator<ChartInput> {
  yield input;
  const trend = input.trend ?? [];
  for (let dropped = 1; dropped <= trend.length; dropped++) {
    yield { ...input, trend: trend.slice(dropped) };
  }
  for (let folded = 1; folded <= input.lines.length; folded++) {
    yield { ...input, trend: [], lines: foldSmallest(input.lines, folded, fold) };
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
