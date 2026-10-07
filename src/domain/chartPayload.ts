// The chart payload (ADR-0025): what a «📈 Диаграмма» button hands the Mini App page, in its URL
// fragment as `#d=<base64url JSON>`. A versioned contract: webapp/src/payload.ts mirrors this
// type and decodes it. Amounts are integer minor units for geometry, each next to a label the
// bot's messages module already formatted, so the page does no money formatting or arithmetic.
// Aggregates only, never an individual expense.

export const CHART_PAYLOAD_VERSION = 1;

// One pie slice: the category name, its amount in minor units, and its formatted amount.
export type ChartLine = readonly [name: string, amountMinor: number, label: string];

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
}

export type ChartInput = Omit<ChartPayloadV1, 'v' | 'totalMinor'>;

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
  };
}

// The `d` value of the button URL's fragment: the payload as base64url (unpadded) of its UTF-8
// JSON, so it holds no `&`, `=` or `#` that would split Telegram's launch parameters.
export function encodeChartPayload(input: ChartInput): string {
  return Buffer.from(JSON.stringify(chartPayload(input)), 'utf8').toString('base64url');
}
