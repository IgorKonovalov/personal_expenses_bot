// The chart payload the bot puts in the button URL's fragment (ADR-0025): `#d=<base64url JSON>`.
// This type mirrors ChartPayloadV1 in the bot's src/domain/chartPayload.ts, which the page can't
// import: it is built alone and shares no code with the bot. Version 1 is the only one read.

export type ChartLine = readonly [name: string, amountMinor: number, label: string];

export interface ChartPayload {
  readonly v: 1;
  readonly title: string;
  readonly currency: string;
  // The integer sum of the lines' amounts, in minor units.
  readonly totalMinor: number;
  readonly totalLabel: string;
  readonly lines: readonly ChartLine[];
  // One formatted line per currency with no rate.
  readonly unconverted: readonly string[];
}

// The raw `d` value from the fragment. Telegram appends its own launch parameters (`tgWebAppData`
// and others), so `d` is read as one key among them.
export function payloadParam(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, '')).get('d') ?? undefined;
}

// The payload in `hash`, or undefined for a missing `d`, broken base64url or JSON, an unknown
// version, or any field of the wrong shape, including lines that don't sum to `totalMinor`.
export function decodeChartPayload(hash: string): ChartPayload | undefined {
  const d = payloadParam(hash);
  if (d === undefined || !/^[A-Za-z0-9_-]+$/.test(d)) return undefined;
  let value: unknown;
  try {
    const binary = atob(d.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  return isChartPayload(value) ? value : undefined;
}

function isChartPayload(value: unknown): value is ChartPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (
    p['v'] !== 1 ||
    typeof p['title'] !== 'string' ||
    typeof p['currency'] !== 'string' ||
    !Number.isSafeInteger(p['totalMinor']) ||
    typeof p['totalLabel'] !== 'string' ||
    !Array.isArray(p['lines']) ||
    !Array.isArray(p['unconverted']) ||
    !p['unconverted'].every((line) => typeof line === 'string')
  ) {
    return false;
  }
  let sum = 0;
  for (const line of p['lines'] as unknown[]) {
    if (!isLine(line)) return false;
    sum += line[1];
  }
  return sum === p['totalMinor'];
}

function isLine(value: unknown): value is ChartLine {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'string' &&
    Number.isSafeInteger(value[1]) &&
    typeof value[2] === 'string'
  );
}
