// The chart payload (ADR-0025): what a «📈 Диаграмма» button hands the Mini App page, in its URL
// fragment as `#d=<base64url JSON>`. A versioned contract: webapp/src/payload.ts mirrors this
// type and decodes it. Amounts are integer minor units for geometry, each next to a label the
// bot's messages module already formatted, so the page does no money formatting or arithmetic.
// Aggregates only, never an individual expense.

export const CHART_PAYLOAD_VERSION = 1;

// The most characters the `d` value may hold. Telegram carries the button URL to the client,
// which opens it with its own launch parameters added; 2048 is the smallest size measured.
export const CHART_PAYLOAD_BUDGET = 2048;

// One pie slice: the category name, its amount in minor units, and its formatted amount.
export type ChartLine = readonly [name: string, amountMinor: number, label: string];

// One trend bar: the period's name, its converted total in minor units, and that total formatted.
export type TrendBar = readonly [periodLabel: string, totalMinor: number, label: string];

export interface ChartPayloadV1 {
  readonly v: typeof CHART_PAYLOAD_VERSION;
  // The period's title, e.g. «Сентябрь 2026».
  readonly title: string;
  // ISO-4217: the ledger's default currency, the block every converted expense sits in.
  readonly currency: string;
  // The sum of the lines' amounts, an integer in minor units.
  readonly totalMinor: number;
  readonly totalLabel: string;
  // Largest first, as the text screen lists them.
  readonly lines: readonly ChartLine[];
  // One formatted line per currency with no rate, never added to the pie.
  readonly unconverted: readonly string[];
  // The shown period and the ones before it, oldest first. Absent when none fit the budget.
  readonly trend?: readonly TrendBar[];
}

export type ChartInput = Omit<ChartPayloadV1, 'v' | 'totalMinor'>;

// The line the smallest categories fold into when the payload is over budget: its name, and the
// formatter for its amount, both from the messages module.
export interface ChartFold {
  readonly name: string;
  readonly label: (amountMinor: number) => string;
}

// The payload for `input`, its `totalMinor` the exact integer sum of the lines.
export function chartPayload(input: ChartInput): ChartPayloadV1 {
  let totalMinor = 0;
  for (const [, amountMinor] of input.lines) {
    totalMinor += amountMinor;
    if (!Number.isSafeInteger(totalMinor)) {
      throw new RangeError('chart total exceeds the safe integer range');
    }
  }
  return {
    v: CHART_PAYLOAD_VERSION,
    title: input.title,
    currency: input.currency,
    totalMinor,
    totalLabel: input.totalLabel,
    lines: input.lines,
    unconverted: input.unconverted,
    ...(input.trend === undefined || input.trend.length === 0 ? {} : { trend: input.trend }),
  };
}

// The `d` value of the button URL's fragment: the payload as base64url (unpadded) of its UTF-8
// JSON, so it holds no `&`, `=` or `#` that would split Telegram's launch parameters. Over
// `budget`, the smallest lines fold into one `fold` line, more of them each try, until it fits;
// with every line folded, the oldest trend bars go one by one. Undefined when nothing fits.
export function encodeChartPayload(
  input: ChartInput,
  fold: ChartFold,
  budget: number = CHART_PAYLOAD_BUDGET,
): string | undefined {
  const encode = (candidate: ChartInput) =>
    Buffer.from(JSON.stringify(chartPayload(candidate)), 'utf8').toString('base64url');
  let encoded = encode(input);
  for (let folded = 1; encoded.length > budget && folded <= input.lines.length; folded++) {
    encoded = encode({ ...input, lines: foldSmallest(input.lines, folded, fold) });
  }
  const allFolded = { ...input, lines: foldSmallest(input.lines, input.lines.length, fold) };
  const trend = input.trend ?? [];
  for (let dropped = 1; encoded.length > budget && dropped <= trend.length; dropped++) {
    encoded = encode({ ...allFolded, trend: trend.slice(dropped) });
  }
  return encoded.length > budget ? undefined : encoded;
}

// `lines` with its `count` smallest lines summed into one `fold` line, put last. A category
// already named like the fold line joins it, so the name never appears twice. The amounts move
// whole, so the result sums to exactly what `lines` sums to.
function foldSmallest(
  lines: readonly ChartLine[],
  count: number,
  fold: ChartFold,
): readonly ChartLine[] {
  const bySize = [...lines].sort((a, b) => b[1] - a[1]);
  const kept = bySize.slice(0, bySize.length - count).filter(([name]) => name !== fold.name);
  const folded = lines.filter((line) => !kept.includes(line));
  if (folded.length === 0) return kept;
  const amountMinor = folded.reduce((sum, [, amount]) => sum + amount, 0);
  return [...kept, [fold.name, amountMinor, fold.label(amountMinor)]];
}
