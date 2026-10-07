import { describe, expect, it } from 'vitest';
import {
  decodeChartPayload,
  type ChartPayloadV2,
  type PieSection,
} from '../../webapp/src/payload.js';
import {
  CHART_PAYLOAD_BUDGET,
  chartPayload,
  encodeBarsPayload,
  encodeChartPayload,
  encodePacePayload,
  type BarsInput,
  type BarsRow,
  type BarsSection,
  type CatTrendPoint,
  type CatTrendSection,
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

  it('encodes a payload of one pace section alone, and refuses it over budget', async () => {
    const pace = {
      k: 'pace',
      days: 30,
      current: [100, 300],
      limit: [3000000, 'Лимит: 30 000.00 RSD'],
      captions: ['Потрачено к 26 сентября: 3.00 RSD', 'Осталось на сегодня: 1 997.00 RSD'],
    } as const;

    expect(await decode(encodePacePayload('Бюджет: 25 сен – 24 окт', pace))).toEqual({
      v: 2,
      title: 'Бюджет: 25 сен – 24 окт',
      sections: [pace],
    });
    expect(encodePacePayload('Бюджет', pace, 10)).toBeUndefined();
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

  it('sheds the change labels first, keeping every trend bar, when just over budget', async () => {
    const next = random(11);
    const lines = many(12, next).map(([name, amount, label, share], i): ChartLine => [
      name,
      amount,
      label,
      share,
      `↑${i + 1}%`,
    ]);
    const input = {
      ...OCTOBER,
      lines,
      totalChange: '↑11% к сентябрю',
      trend: trend(6, next),
    };
    const full = encodeChartPayload(input, FOLD, Infinity)?.length ?? 0;

    const decoded = await decode(encodeChartPayload(input, FOLD, full - 1));

    const pie = pieOf(decoded);
    expect(pie.totalChange).toBeUndefined();
    expect(pie.lines).toEqual(lines.map((line) => line.slice(0, 4)));
    expect(barsOf(decoded)).toEqual(input.trend);
  });

  it('carries the change labels and the total change when they fit', async () => {
    const input: ChartInput = {
      ...OCTOBER,
      totalChange: '↑11% к сентябрю',
      lines: [
        ['Еда', 120000, '1 200.00 RSD', '78%', '↑20%'],
        ['Транспорт', 30000, '300.00 RSD', '19%', '↓25%'],
        ['Кафе', 5000, '50.00 RSD', '3%', 'новое'],
      ],
    };

    const pie = pieOf(await decode(encodeChartPayload(input, FOLD)));

    expect(pie.totalChange).toBe('↑11% к сентябрю');
    expect(pie.lines).toEqual(input.lines);
  });

  describe('the pace section', () => {
    const points = (count: number, next: () => number) => {
      let total = 0;
      return Array.from({ length: count }, () => (total += Math.floor(next() * 9_999_999)));
    };
    const paceInput = (next: () => number): ChartInput => ({
      ...OCTOBER,
      lines: many(6, next).map(([name, amount, label, share], i): ChartLine => [
        name,
        amount,
        label,
        share,
        `↑${i + 1}%`,
      ]),
      totalChange: '↑11% к сентябрю',
      pace: {
        k: 'pace',
        days: 31,
        current: points(15, next),
        previous: points(30, next),
        captions: ['К 15 октября: 1.00 RSD', 'К 15 сентября: 2.00 RSD'],
      },
      trend: trend(6, next),
    });
    const sizeOf = (input: ChartInput) => encodeChartPayload(input, FOLD, Infinity)?.length ?? 0;
    const paceOf = (payload: ChartPayloadV2) =>
      payload.sections.find((section) => section.k === 'pace');

    it('goes between the pie and the trend, round-tripping whole', async () => {
      const input = paceInput(random(12));

      const decoded = await decode(encodeChartPayload(input, FOLD, Infinity));

      expect(decoded.sections.map((section) => section.k)).toEqual(['pie', 'pace', 'trend']);
      expect(paceOf(decoded)).toEqual(input.pace);
    });

    it('sheds the previous series and its caption after the change labels, then the pace, before any trend bar', async () => {
      const input = paceInput(random(13));
      // Just under the full payload: the change labels go, the pace stays whole.
      const changesShed = await decode(encodeChartPayload(input, FOLD, sizeOf(input) - 1));
      const withoutChanges = encodeChartPayload(input, FOLD, sizeOf(input) - 1)?.length ?? 0;

      // Just under the payload without change labels: the previous series goes.
      const noPrevious = await decode(encodeChartPayload(input, FOLD, withoutChanges - 1));
      const lastWithPace = encodeChartPayload(input, FOLD, withoutChanges - 1)?.length ?? 0;
      // Just under that: the pace section goes, every trend bar kept.
      const noPace = await decode(encodeChartPayload(input, FOLD, lastWithPace - 1));

      expect(pieOf(changesShed).totalChange).toBeUndefined();
      expect(paceOf(changesShed)).toEqual(input.pace);
      expect(pieOf(noPrevious).totalChange).toBeUndefined();
      expect(paceOf(noPrevious)).toEqual({
        k: 'pace',
        days: 31,
        current: input.pace?.current,
        captions: ['К 15 октября: 1.00 RSD'],
      });
      expect(barsOf(noPrevious)).toEqual(input.trend);
      expect(paceOf(noPace)).toBeUndefined();
      expect(barsOf(noPace)).toEqual(input.trend);
      expect(pieOf(noPace).lines).toEqual(input.lines.map((line) => line.slice(0, 4)));
    });
  });

  describe('the catTrend section', () => {
    const PERIODS = ['Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь'];
    const series = (lines: readonly ChartLine[], next: () => number): CatTrendSection => ({
      k: 'catTrend',
      caption: 'Последние 6 месяцев',
      periods: PERIODS,
      series: lines.map(
        ([, amountMinor], index) =>
          [
            index,
            PERIODS.map((_, i): CatTrendPoint => {
              const amount = i === PERIODS.length - 1 ? amountMinor : Math.floor(next() * 1e7);
              return [amount, `${amount} ${Math.floor(next() * 1e9).toString(36)}`];
            }),
          ] as const,
      ),
    });
    const catTrendOf = (payload: ChartPayloadV2) =>
      payload.sections.find((section): section is CatTrendSection => section.k === 'catTrend');
    const sizeOf = (input: ChartInput) => encodeChartPayload(input, FOLD, Infinity)?.length ?? 0;

    it('goes last and round-trips whole', async () => {
      const catTrend = series(OCTOBER.lines, random(20));

      const decoded = await decode(
        encodeChartPayload({ ...OCTOBER, trend: SIX_BARS, catTrend }, FOLD, Infinity),
      );

      expect(decoded.sections.map((section) => section.k)).toEqual(['pie', 'trend', 'catTrend']);
      expect(catTrendOf(decoded)).toEqual(catTrend);
    });

    it("sheds the smallest line's series first, before any change label", async () => {
      const lines: ChartLine[] = [
        ['Еда', 120000, '1 200.00 RSD', '78%', '↑20%'],
        ['Кафе', 5000, '50.00 RSD', '3%', 'новое'],
        ['Транспорт', 30000, '300.00 RSD', '19%', '↓25%'],
      ];
      const input: ChartInput = {
        ...OCTOBER,
        lines,
        totalChange: '↑11% к сентябрю',
        trend: SIX_BARS,
        catTrend: series(lines, random(21)),
      };

      const decoded = await decode(encodeChartPayload(input, FOLD, sizeOf(input) - 1));

      expect(catTrendOf(decoded)?.series.map(([line]) => line)).toEqual([0, 2]);
      expect(pieOf(decoded).lines).toEqual(lines);
      expect(pieOf(decoded).totalChange).toBe('↑11% к сентябрю');
    });

    it('keeps series only for a prefix of the lines by amount, and none once a line folds, over 200 seeded cases', async () => {
      const next = random(40);
      let partial = 0;
      let foldedCases = 0;
      for (let run = 0; run < 200; run++) {
        const count = 1 + Math.floor(next() * 25);
        const lines: ChartLine[] = Array.from({ length: count }, (_, i) => [
          `Категория ${i} ${Math.floor(next() * 1e9).toString(36)}`,
          Math.floor(next() * 10_000_000),
          `${Math.floor(next() * 1e9)} RSD`,
          '1%',
        ]);
        const catTrend = series(lines, next);
        const budget = 200 + Math.floor(next() * 2500);

        const encoded = encodeChartPayload({ ...OCTOBER, lines, catTrend }, FOLD, budget);

        if (encoded === undefined) continue;
        const decoded = await decode(encoded);
        const kept = catTrendOf(decoded)?.series ?? [];
        const keptLines = new Set(kept.map(([line]) => line));
        const amount = (index: number) => lines[index]?.[1] ?? 0;
        const smallestKept = Math.min(...[...keptLines].map(amount));
        const largestShed = Math.max(
          ...lines.flatMap((_, index) => (keptLines.has(index) ? [] : [amount(index)])),
        );
        expect(smallestKept).toBeGreaterThanOrEqual(largestShed);
        // A kept series is the one sent for its line.
        for (const entry of kept) expect(catTrend.series[entry[0]]).toEqual(entry);
        if (kept.length > 0 && kept.length < lines.length) partial++;
        if (JSON.stringify(pieOf(decoded).lines) !== JSON.stringify(lines)) {
          foldedCases++;
          expect(catTrendOf(decoded)).toBeUndefined();
        }
      }
      // The cases reach both a partly shed section and folding.
      expect(partial).toBeGreaterThan(20);
      expect(foldedCases).toBeGreaterThan(20);
    });
  });

  it('is undefined when nothing is left to fold or drop', () => {
    expect(
      encodeChartPayload({ ...OCTOBER, trend: trend(6, random(10)) }, FOLD, 50),
    ).toBeUndefined();
  });
});

describe('encodeBarsPayload', () => {
  // `count` rows, oldest first, with varied amounts so deflate can't fold them.
  const rows = (count: number, next: () => number): BarsRow[] =>
    Array.from({ length: count }, (_, index) => {
      const amountMinor = Math.floor(next() * 10_000_000);
      return [`Месяц ${String(index + 1)}`, amountMinor, `${String(amountMinor)} RSD`];
    });
  const MILK: BarsInput = {
    title: 'Молоко',
    primary: {
      k: 'bars',
      caption: 'Цена за 1 л',
      rows: [
        ['Июль 2026', 12990, '129.90 RSD/л'],
        ['Август 2026', null, 'размер не указан'],
        ['Сентябрь 2026', 13490, '134.90 RSD/л'],
      ],
      notes: ['Июнь 2026: 1.50 EUR · 1 л · 1.50 EUR/л'],
    },
    secondary: {
      k: 'bars',
      caption: 'Траты по месяцам',
      rows: [
        ['Июль 2026', 25980, '259.80 RSD'],
        ['Август 2026', 15000, '150.00 RSD'],
        ['Сентябрь 2026', 13490, '134.90 RSD'],
      ],
    },
  };

  it('round-trips both sections through the page decoder, a null row kept', async () => {
    expect(await decode(encodeBarsPayload(MILK))).toEqual({
      v: 2,
      title: 'Молоко',
      sections: [MILK.primary, MILK.secondary],
    });
  });

  it('sheds the secondary section before any primary row, then the oldest primary rows', async () => {
    const input: BarsInput = {
      title: 'Молоко',
      primary: { k: 'bars', caption: 'Цена за 1 л', rows: rows(24, random(3)) },
      secondary: { k: 'bars', caption: 'Траты по месяцам', rows: rows(24, random(4)) },
    };
    const sizeOf = (budget: number) => encodeBarsPayload(input, budget)?.length ?? 0;
    const full = sizeOf(Infinity);

    const first = await decode(encodeBarsPayload(input, full - 1));
    expect(first.sections).toEqual([input.primary]);

    let budget = sizeOf(full - 1) - 1;
    const kept: number[] = [];
    for (let left = 23; left >= 1; left--) {
      const decoded = await decode(encodeBarsPayload(input, budget));
      const [section] = decoded.sections as BarsSection[];
      expect(section?.rows).toEqual(input.primary.rows.slice(24 - left));
      kept.push(section?.rows.length ?? 0);
      budget = sizeOf(budget) - 1;
    }
    expect(kept).toEqual(Array.from({ length: 23 }, (_, index) => 23 - index));
    expect(encodeBarsPayload(input, budget)).toBeUndefined();
  });
});
