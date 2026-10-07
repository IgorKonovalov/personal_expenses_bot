import { describe, expect, it } from 'vitest';
import { decodeChartPayload, type ChartPayload } from '../../webapp/src/payload.js';
import {
  CHART_PAYLOAD_BUDGET,
  chartPayload,
  encodeChartPayload,
  type ChartFold,
  type ChartInput,
  type ChartLine,
} from './chartPayload.js';

const SEPTEMBER: ChartInput = {
  title: 'Сентябрь 2026',
  currency: 'RSD',
  totalLabel: '1 500.00 RSD',
  lines: [
    ['Еда', 120000, '1 200.00 RSD'],
    ['Транспорт', 30000, '300.00 RSD'],
  ],
  unconverted: ['Без курса НБС: 12.50 EUR'],
};

const FOLD: ChartFold = { name: 'Прочее', label: (amountMinor) => `${amountMinor} RSD` };

const decode = (d: string | undefined): ChartPayload => {
  const payload = d === undefined ? undefined : decodeChartPayload(`#d=${d}`);
  if (payload === undefined) throw new Error('a payload the page reads expected');
  return payload;
};

// A deterministic generator, so a failing case reruns the same.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('encodeChartPayload', () => {
  it("round-trips through the page's decodeChartPayload to the same lines and a total of 150000", () => {
    const decoded = decodeChartPayload(`#d=${encodeChartPayload(SEPTEMBER, FOLD) ?? ''}`);

    expect(decoded).toEqual({
      v: 1,
      title: 'Сентябрь 2026',
      currency: 'RSD',
      totalMinor: 150000,
      totalLabel: '1 500.00 RSD',
      lines: [
        ['Еда', 120000, '1 200.00 RSD'],
        ['Транспорт', 30000, '300.00 RSD'],
      ],
      unconverted: ['Без курса НБС: 12.50 EUR'],
    });
  });

  it('carries the trend bars oldest first', () => {
    const trend = [
      ['Август', 0, '0.00 RSD'],
      ['Сентябрь', 150000, '1 500.00 RSD'],
    ] as const;

    expect(decode(encodeChartPayload({ ...SEPTEMBER, trend }, FOLD)).trend).toEqual(trend);
  });

  it('writes unpadded base64url, with nothing that splits a fragment parameter', () => {
    expect(encodeChartPayload(SEPTEMBER, FOLD)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a total beyond the safe integer range', () => {
    expect(() =>
      chartPayload({
        ...SEPTEMBER,
        lines: [
          ['a', Number.MAX_SAFE_INTEGER, ''],
          ['b', 1, ''],
        ],
      }),
    ).toThrow(RangeError);
  });
});

describe('the payload budget', () => {
  const many = (count: number): ChartLine[] =>
    Array.from({ length: count }, (_, i) => [
      `Категория номер ${i + 1} с длинным названием`,
      (count - i) * 1000,
      `${(count - i) * 10}.00 RSD`,
    ]);
  const trend = (count: number) =>
    Array.from({ length: count }, (_, i) => [`Период ${i + 1}`, i * 100, `${i}.00 RSD`] as const);

  it('folds the smallest lines into one «Прочее» line, put last, until it fits', () => {
    const lines = many(40);
    const encoded = encodeChartPayload({ ...SEPTEMBER, lines }, FOLD);

    expect(encoded?.length).toBeLessThanOrEqual(CHART_PAYLOAD_BUDGET);
    const decoded = decode(encoded);
    const other = decoded.lines.at(-1);
    const kept = decoded.lines.slice(0, -1);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(lines.slice(0, kept.length));
    const rest = lines.slice(kept.length).reduce((sum, [, amount]) => sum + amount, 0);
    expect(other).toEqual(['Прочее', rest, `${rest} RSD`]);
  });

  it('folds nothing when the payload fits', () => {
    const lines = many(5);

    expect(decode(encodeChartPayload({ ...SEPTEMBER, lines }, FOLD)).lines).toEqual(lines);
  });

  it('keeps the folded sum equal to the original total, and the length within the budget', () => {
    const next = random(30);
    for (let run = 0; run < 200; run++) {
      const count = 1 + Math.floor(next() * 60);
      const lines: ChartLine[] = Array.from({ length: count }, (_, i) => [
        `Категория ${i} ${'ж'.repeat(Math.floor(next() * 30))}`,
        Math.floor(next() * 10_000_000),
        'x RSD',
      ]);
      if (next() < 0.1) lines.push(['Прочее', Math.floor(next() * 5000), 'x RSD']);
      const original = chartPayload({ ...SEPTEMBER, lines }).totalMinor;
      const budget = 300 + Math.floor(next() * 3000);

      const encoded = encodeChartPayload(
        { ...SEPTEMBER, lines, trend: trend(Math.floor(next() * 7)) },
        FOLD,
        budget,
      );

      if (encoded === undefined) continue;
      expect(encoded.length).toBeLessThanOrEqual(budget);
      const decoded = decode(encoded);
      expect(decoded.lines.reduce((sum, [, amount]) => sum + amount, 0)).toBe(original);
      expect(decoded.totalMinor).toBe(original);
      expect(decoded.lines.filter(([name]) => name === 'Прочее').length).toBeLessThanOrEqual(1);
    }
  });

  it('drops the oldest trend bars once every line is folded', () => {
    const input = { ...SEPTEMBER, lines: many(3), trend: trend(6) };
    const allFolded = { ...input, lines: [['Прочее', 6000, '6000 RSD']] as const };
    const allFoldedLength = encodeChartPayload(allFolded, FOLD, Infinity)?.length ?? 0;

    const decoded = decode(encodeChartPayload(input, FOLD, allFoldedLength - 1));

    expect(decoded.lines).toEqual([['Прочее', 6000, '6000 RSD']]);
    expect(decoded.trend).toEqual(trend(6).slice(1));
  });

  it('is undefined when nothing is left to fold or drop', () => {
    expect(encodeChartPayload({ ...SEPTEMBER, trend: trend(6) }, FOLD, 100)).toBeUndefined();
  });
});
