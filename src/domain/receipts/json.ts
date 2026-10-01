// JSON with every number kept as its source text (ADR-0018): `JSON.parse`'s reviver receives the
// literal as written, so `0.29` is read as the digits `0.29`, never as a float.

export class JsonNumber {
  constructor(readonly source: string) {}
}

export type JsonValue =
  | string
  | boolean
  | null
  | JsonNumber
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// Undefined for text that isn't JSON.
export function parseJsonKeepingNumbers(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && context?.source !== undefined
        ? new JsonNumber(context.source)
        : value,
    ) as JsonValue;
  } catch {
    return undefined;
  }
}

export function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  if (value instanceof JsonNumber || Array.isArray(value)) return undefined;
  return (value as { readonly [key: string]: JsonValue })[key];
}

export function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function numberSource(value: JsonValue | undefined): string | undefined {
  return value instanceof JsonNumber ? value.source : undefined;
}

export function list(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  return Array.isArray(value) ? (value as readonly JsonValue[]) : undefined;
}
