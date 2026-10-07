import { describe, expect, it } from 'vitest';
import {
  decodeChartPayload,
  type ChartPayloadV2,
  type PieSection,
} from '../../webapp/src/payload.js';
import {
  CHART_PAYLOAD_BUDGET,
  chartPayload,
  encodeChartPayload,
  type ChartFold,
  type ChartInput,
  type ChartLine,
  type TrendBar,
} from './chartPayload.js';
import { sharesOf } from './shares.js';

const OCTOBER: ChartInput = {
  title: 'Октябрь 2026',
  currency: 'RSD',
  totalLabel: '1 550.00 RSD',
  lines: [
    ['Еда', 120000, '1 200.00 RSD', '78%'],
    ['Транспорт', 30000, '300.00 RSD', '19%'],
    ['Кафе', 5000, '50.00 RSD', '3%'],
  ],
  unconverted: ['Без курса НБС: 12.50 EUR'],
};

const SIX_BARS: readonly TrendBar[] = [
  ['Май', 0, '0.00 RSD'],
  ['Июнь', 12500, '125.00 RSD'],
  ['Июль', 0, '0.00 RSD'],
  ['Август', 40000, '400.00 RSD'],
  ['Сентябрь', 140000, '1 400.00 RSD'],
  ['Октябрь', 155000, '1 550.00 RSD'],
];

const FOLD: ChartFold = {
  name: 'Прочее',
  label: (amountMinor) => `${amountMinor} RSD`,
  share: (percent) => `${percent}%`,
};

const decode = async (z: string | undefined): Promise<ChartPayloadV2> => {
  const payload = z === undefined ? undefined : await decodeChartPayload(`#z=${z}`);
  if (payload?.v !== 2) throw new Error('a v2 payload the page reads expected');
  return payload;
};
const pieOf = (payload: ChartPayloadV2): PieSection => {
  const pie = payload.sections.find((section): section is PieSection => section.k === 'pie');
  if (pie === undefined) throw new Error('a pie section expected');
  return pie;
};
const barsOf = (payload: ChartPayloadV2) =>
  payload.sections.flatMap((section) =>
    section.k === 'trend' && 'bars' in section ? [section.bars] : [],
  )[0];

// A deterministic generator, so a failing case reruns the same.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('encodeChartPayload', () => {
  it("round-trips through the page's decodeChartPayload to a v2 pie of 155000 and a 6-bar trend", async () => {
    const z = encodeChartPayload({ ...OCTOBER, trend: SIX_BARS }, FOLD);

    expect(await decodeChartPayload(`#z=${z ?? ''}`)).toEqual({
      v: 2,
      title: 'Октябрь 2026',
      sections: [
        {
          k: 'pie',
          currency: 'RSD',
          totalMinor: 155000,
          totalLabel: '1 550.00 RSD',
          lines: [
            ['Еда', 120000, '1 200.00 RSD', '78%'],
            ['Транспорт', 30000, '300.00 RSD', '19%'],
            ['Кафе', 5000, '50.00 RSD', '3%'],
          ],
          unconverted: ['Без курса НБС: 12.50 EUR'],
        },
        { k: 'trend', bars: SIX_BARS },
      ],
    });
  });

  it('emits only section kinds the page draws', async () => {
    const decoded = await decode(encodeChartPayload({ ...OCTOBER, trend: SIX_BARS }, FOLD));

    expect(decoded.sections.map((section) => section.k)).toEqual(['pie', 'trend']);
  });

  it('leaves the trend section out when there are no bars', async () => {
    const decoded = await decode(encodeChartPayload({ ...OCTOBER, trend: [] }, FOLD));

    expect(decoded.sections.map((section) => section.k)).toEqual(['pie']);
  });

  it('writes unpadded base64url, with nothing that splits a fragment parameter', () => {
    expect(encodeChartPayload(OCTOBER, FOLD)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a total beyond the safe integer range', () => {
    expect(() =>
      chartPayload({
        ...OCTOBER,
        lines: [
          ['a', Number.MAX_SAFE_INTEGER, '', ''],
          ['b', 1, '', ''],
        ],
      }),
    ).toThrow(RangeError);
  });
});

describe('the payload budget', () => {
  // Names and labels with no repeats a deflate window could share, so they cost their length.
  const many = (count: number, next: () => number): ChartLine[] =>
    Array.from({ length: count }, (_, i) => [
      `Категория ${Math.floor(next() * 1e9).toString(36)} ${i}`,
      (count - i) * 1000,
      `${Math.floor(next() * 1e9)}.00 RSD`,
      '1%',
    ]);
  const trend = (count: number, next: () => number): TrendBar[] =>
    Array.from({ length: count }, (_, i) => [
      `Период ${Math.floor(next() * 1e9).toString(36)}`,
      i * 100,
      `${Math.floor(next() * 1e9)}.00 RSD`,
    ]);

  it('folds the smallest lines into one «Прочее» line, put last, its share their shares summed', async () => {
    const next = random(7);
    const lines = many(200, next);
    const encoded = encodeChartPayload({ ...OCTOBER, lines }, FOLD);

    expect(encoded?.length).toBeLessThanOrEqual(CHART_PAYLOAD_BUDGET);
    const decoded = pieOf(await decode(encoded));
    const other = decoded.lines.at(-1);
    const kept = decoded.lines.slice(0, -1);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(lines.slice(0, kept.length));
    const rest = lines.slice(kept.length).reduce((sum, [, amount]) => sum + amount, 0);
    const shares = sharesOf(lines.map(([, amount]) => amount));
    const restShare = shares.slice(kept.length).reduce((sum, share) => sum + share, 0);
    expect(other).toEqual(['Прочее', rest, `${rest} RSD`, `${restShare}%`]);
  });

  it('folds nothing when the payload fits', async () => {
    const lines = many(5, random(8));

    expect(pieOf(await decode(encodeChartPayload({ ...OCTOBER, lines }, FOLD))).lines).toEqual(
      lines,
    );
  });

  it('drops the oldest trend bars one by one before folding any line', async () => {
    const next = random(9);
    const input = { ...OCTOBER, lines: many(3, next), trend: trend(6, next) };
    const full = encodeChartPayload(input, FOLD, Infinity)?.length ?? 0;

    const decoded = await decode(encodeChartPayload(input, FOLD, full - 1));

    expect(pieOf(decoded).lines).toEqual(input.lines);
    expect(barsOf(decoded)).toEqual(input.trend.slice(1));
  });

  it('keeps the folded sum equal to the original total, and the length within the budget, over 200 seeded cases', async () => {
    const next = random(30);
    let foldedCases = 0;
    for (let run = 0; run < 200; run++) {
      const count = 1 + Math.floor(next() * 60);
      const lines: ChartLine[] = Array.from({ length: count }, (_, i) => [
        `Категория ${i} ${'ж'.repeat(Math.floor(next() * 30))}${Math.floor(next() * 1e9).toString(36)}`,
        Math.floor(next() * 10_000_000),
        `${Math.floor(next() * 1e9)} RSD`,
        '1%',
      ]);
      if (next() < 0.1) lines.push(['Прочее', Math.floor(next() * 5000), 'x RSD', '1%']);
      const original = chartPayload({ ...OCTOBER, lines }).sections[0];
      const bars = trend(Math.floor(next() * 7), next);
      const budget = 200 + Math.floor(next() * 1500);

      const encoded = encodeChartPayload({ ...OCTOBER, lines, trend: bars }, FOLD, budget);

      if (encoded === undefined) continue;
      expect(encoded.length).toBeLessThanOrEqual(budget);
      const decoded = await decode(encoded);
      const pie = pieOf(decoded);
      const originalTotal = original?.k === 'pie' ? original.totalMinor : NaN;
      expect(pie.lines.reduce((sum, [, amount]) => sum + amount, 0)).toBe(originalTotal);
      expect(pie.totalMinor).toBe(originalTotal);
      expect(pie.lines.filter(([name]) => name === 'Прочее').length).toBeLessThanOrEqual(1);
      // Trend bars go before any line folds: a folded pie has no trend left.
      if (JSON.stringify(pie.lines) !== JSON.stringify(lines)) {
        foldedCases++;
        expect(barsOf(decoded)).toBeUndefined();
      }
    }
    // The cases reach folding, not only the trend.
    expect(foldedCases).toBeGreaterThan(20);
  });

  it('is undefined when nothing is left to fold or drop', () => {
    expect(
      encodeChartPayload({ ...OCTOBER, trend: trend(6, random(10)) }, FOLD, 50),
    ).toBeUndefined();
  });
});
