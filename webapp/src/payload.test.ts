import { describe, expect, it, vi } from 'vitest';
import { drawBars, drawTrend } from './bars.js';
import { messages } from './messages.js';
import { decodeChartPayload } from './payload.js';
import { DARK, LIGHT } from './palette.js';
import {
  showChart,
  startChart,
  type ChartDocument,
  type ChartNode,
  type ChartStyle,
  type ChartTheme,
  type ChartWebApp,
} from './pie.js';

// A DOM stand-in: builds a tree from createElement/createElementNS and textContent alone. It has
// no markup parser, and assigning markup through innerHTML or outerHTML throws. Inline style goes
// through `style` only: the CSP blocks a `style` attribute, so setting one throws.
// `click()` is test-side: it runs the node's click listeners, as a tap would.
class FakeNode implements ChartNode<FakeNode> {
  textContent: string | null = null;
  readonly style: ChartStyle = {
    maxWidth: '',
    display: '',
    margin: '',
    minHeight: '',
    fontWeight: '',
    backgroundColor: '',
    color: '',
  };
  readonly attributes = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly listeners: (() => void)[] = [];
  constructor(
    readonly tag: string,
    readonly namespace?: string,
  ) {}
  setAttribute(name: string, value: string): void {
    if (name === 'style') throw new Error('style attribute');
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }
  addEventListener(_type: 'click', listener: () => void): void {
    this.listeners.push(listener);
  }
  click(): void {
    for (const listener of this.listeners) listener();
  }
  set innerHTML(_markup: string) {
    throw new Error('innerHTML');
  }
  set outerHTML(_markup: string) {
    throw new Error('outerHTML');
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

function fakeDocument(): ChartDocument<FakeNode> {
  return {
    title: 'Скан чека',
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag, namespace),
  };
}

async function page(hash: string, onSelect: () => void = () => {}) {
  const doc = fakeDocument();
  const root = new FakeNode('body');
  await showChart(doc, root, hash, {}, onSelect);
  const nodes = root.all().slice(1);
  return {
    doc,
    root,
    nodes,
    tags: nodes.map((node) => node.tag),
    texts: nodes.map((node) => node.textContent).filter((text) => text !== null),
  };
}

// base64url of UTF-8 text, as the bot's v1 encoder wrote it.
function base64url(text: string): string {
  return base64urlOf(new TextEncoder().encode(text));
}

function base64urlOf(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The `z` value for `payload`: zlib deflate of its UTF-8 JSON as base64url, as the bot's encoder
// writes it (src/domain/chartPayload.ts, whose round trip through decodeChartPayload is tested
// there).
async function deflated(payload: object): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(JSON.stringify(payload))])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return base64urlOf(new Uint8Array(await new Response(stream).arrayBuffer()));
}

const OCTOBER_PIE = {
  k: 'pie',
  currency: 'RSD',
  totalMinor: 155000,
  totalLabel: '1 550.00 RSD',
  lines: [
    ['Еда', 120000, '120 000.00 RSD', '78%'],
    ['Транспорт', 30000, '30 000.00 RSD', '19%'],
    ['Кафе', 5000, '5 000.00 RSD', '3%'],
  ],
  unconverted: [] as string[],
};
const OCTOBER_TREND = {
  k: 'trend',
  bars: [
    ['Сентябрь', 140000, '1 400.00 RSD'],
    ['Октябрь', 155000, '1 550.00 RSD'],
  ],
};
const OCTOBER = { v: 2, title: 'Октябрь 2026', sections: [OCTOBER_PIE, OCTOBER_TREND] };

const SEPTEMBER = {
  v: 1,
  title: 'Сентябрь 2026',
  currency: 'RSD',
  totalMinor: 150000,
  totalLabel: '1 500.00 RSD',
  lines: [
    ['Еда', 120000, '1 200.00 RSD'],
    ['Транспорт', 30000, '300.00 RSD'],
  ],
  unconverted: [] as string[],
};

const encoded = (payload: object) => base64url(JSON.stringify(payload));

describe('decodeChartPayload', () => {
  it('reads d next to the launch parameters Telegram appends', async () => {
    const d = encoded(SEPTEMBER);

    expect(await decodeChartPayload(`#tgWebAppVersion=8.0&d=${d}&tgWebAppPlatform=ios`)).toEqual(
      SEPTEMBER,
    );
  });

  it('reads a v2 z next to the launch parameters, unknown sections kept as they came', async () => {
    const payload = { ...OCTOBER, sections: [OCTOBER_PIE, { k: 'nope', x: 1 }, OCTOBER_TREND] };
    const z = await deflated(payload);

    expect(await decodeChartPayload(`#tgWebAppVersion=8.0&z=${z}`)).toEqual(payload);
  });

  it('rejects an unknown version, broken base64 or JSON, a missing d, and lines off the total', async () => {
    const valid = SEPTEMBER;

    expect(await decodeChartPayload(`#d=${base64url(JSON.stringify({ ...valid, v: 2 }))}`)).toBe(
      undefined,
    );
    expect(await decodeChartPayload('#d=%%%not-base64')).toBe(undefined);
    expect(await decodeChartPayload(`#d=${base64url('{"v":1,')}`)).toBe(undefined);
    expect(await decodeChartPayload('#tgWebAppVersion=8.0')).toBe(undefined);
    expect(await decodeChartPayload('')).toBe(undefined);
    expect(
      await decodeChartPayload(`#d=${base64url(JSON.stringify({ ...valid, totalMinor: 150001 }))}`),
    ).toBe(undefined);
    expect(
      await decodeChartPayload(
        `#d=${base64url(JSON.stringify({ ...valid, lines: [['Еда', 1.5, '0.02 RSD']], totalMinor: 1.5 }))}`,
      ),
    ).toBe(undefined);
  });

  it('rejects a z that is not deflate, a v1 body in z, and a pie off its total', async () => {
    expect(await decodeChartPayload(`#z=${base64url(JSON.stringify(OCTOBER))}`)).toBe(undefined);
    expect(await decodeChartPayload(`#z=${await deflated(SEPTEMBER)}`)).toBe(undefined);
    const off = { ...OCTOBER, sections: [{ ...OCTOBER_PIE, totalMinor: 155001 }] };
    expect(await decodeChartPayload(`#z=${await deflated(off)}`)).toBe(undefined);
    const noShare = {
      ...OCTOBER,
      sections: [{ ...OCTOBER_PIE, lines: [['Еда', 155000, '1 550.00 RSD']] }],
    };
    expect(await decodeChartPayload(`#z=${await deflated(noShare)}`)).toBe(undefined);
  });

  it('reads a trend, and rejects a trend bar of the wrong shape', async () => {
    const trend = [
      ['Август', 0, '0.00 RSD'],
      ['Сентябрь', 150000, '1 500.00 RSD'],
    ];

    const decoded = await decodeChartPayload(`#d=${encoded({ ...SEPTEMBER, trend })}`);
    expect(decoded?.v === 1 ? decoded.trend : undefined).toEqual(trend);
    expect(
      await decodeChartPayload(`#d=${encoded({ ...SEPTEMBER, trend: [['Август', 0.5, '']] })}`),
    ).toBe(undefined);
    expect(await decodeChartPayload(`#d=${encoded({ ...SEPTEMBER, trend: 'Август' })}`)).toBe(
      undefined,
    );
  });
});

describe('a v2 chart', () => {
  it('draws the pie and the trend and nothing for an unknown section between them', async () => {
    const payload = { ...OCTOBER, sections: [OCTOBER_PIE, { k: 'nope', x: 1 }, OCTOBER_TREND] };
    const { root, texts } = await page(`#z=${await deflated(payload)}`);

    expect(root.children.map((node) => node.tag)).toEqual(['h1', 'p', 'svg', 'p', 'ul', 'svg']);
    expect(texts).toEqual([
      'Октябрь 2026',
      '1 550.00 RSD',
      '1 550.00 RSD',
      'Всего',
      messages.chartTapHint,
      ' Еда: 120 000.00 RSD · 78%',
      ' Транспорт: 30 000.00 RSD · 19%',
      ' Кафе: 5 000.00 RSD · 3%',
      'Сентябрь · 1 400.00 RSD',
      'Октябрь · 1 550.00 RSD',
    ]);
  });

  it('adds each line change to its legend row, and the total change to the centre', async () => {
    const pie = {
      ...OCTOBER_PIE,
      totalChange: '↑11% к сентябрю',
      lines: [
        ['Еда', 120000, '120 000.00 RSD', '78%', '↑20%'],
        ['Транспорт', 30000, '30 000.00 RSD', '19%', '↓25%'],
        ['Кафе', 5000, '5 000.00 RSD', '3%', 'новое'],
      ],
    };
    const { nodes, texts } = await page(`#z=${await deflated({ ...OCTOBER, sections: [pie] })}`);

    expect(texts).toContain(' Еда: 120 000.00 RSD · 78% · ↑20%');
    expect(texts).toContain(' Транспорт: 30 000.00 RSD · 19% · ↓25%');
    expect(texts).toContain(' Кафе: 5 000.00 RSD · 3% · новое');
    const donut = nodes.find((node) => node.attributes.get('role') === 'img');
    const centre = donut?.children.filter((node) => node.tag === 'text');
    expect(centre?.map((node) => node.textContent)).toEqual(['1 550.00 RSD', '↑11% к сентябрю']);
    // Past 12 characters, the caption is squeezed to the hole's width.
    expect(centre?.[1]?.attributes.get('textLength')).toBe('1.1');
  });

  it('rejects a change that is not a string, and a line past the change', async () => {
    const lines = (extra: unknown[]) => [['Еда', 155000, '1 550.00 RSD', '100%', ...extra]];
    for (const extra of [[20], ['↑20%', 'x']]) {
      const pie = { ...OCTOBER_PIE, lines: lines(extra) };
      expect(
        await decodeChartPayload(`#z=${await deflated({ ...OCTOBER, sections: [pie] })}`),
      ).toBe(undefined);
    }
    const badTotal = { ...OCTOBER_PIE, totalChange: 11 };
    expect(
      await decodeChartPayload(`#z=${await deflated({ ...OCTOBER, sections: [badTotal] })}`),
    ).toBe(undefined);
  });

  it('shows only chartBroken for a pie whose lines miss its total, or a z that is not deflate', async () => {
    const off = { ...OCTOBER, sections: [{ ...OCTOBER_PIE, totalMinor: 155001 }, OCTOBER_TREND] };
    for (const hash of [`#z=${await deflated(off)}`, `#z=${base64url(JSON.stringify(OCTOBER))}`]) {
      const { tags, texts } = await page(hash);
      expect(tags).toEqual(['p']);
      expect(texts).toEqual([messages.chartBroken]);
    }
  });

  it('shows only chartUnsupported on a client without DecompressionStream', async () => {
    const hash = `#z=${await deflated(OCTOBER)}`;
    vi.stubGlobal('DecompressionStream', undefined);
    try {
      const { tags, texts } = await page(hash);

      expect(tags).toEqual(['p']);
      expect(texts).toEqual([messages.chartUnsupported]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the pace section', () => {
  const PACE = {
    k: 'pace',
    days: 5,
    current: [10000, 20000, 45000],
    previous: [30000, 30000, 60000, 80000, 90000],
    captions: ['К 3 октября: 450.00 RSD', 'К 3 сентября: 600.00 RSD'],
  };
  const pacePage = async (pace: object, theme: ChartTheme = {}) => {
    const root = new FakeNode('body');
    const hash = `#z=${await deflated({ ...OCTOBER, sections: [OCTOBER_PIE, pace, OCTOBER_TREND] })}`;
    await showChart(fakeDocument(), root, hash, theme);
    const lines = root.all().filter((node) => node.tag === 'polyline');
    const chart = root.children.find((node) => node.children.includes(lines[0] ?? root));
    return { root, lines, chart };
  };
  const pointsOf = (line: FakeNode | undefined) =>
    (line?.attributes.get('points') ?? '').split(' ').map((point) => point.split(',').map(Number));

  it('draws the previous line muted and the current one in the accent colour, under its captions', async () => {
    const { root, lines } = await pacePage(PACE, { button: '#5288c1', hint: '#708499' });

    expect(lines.map((line) => line.attributes.get('stroke'))).toEqual(['#708499', '#5288c1']);
    // Between the donut's legend and the trend: two captions, then the chart.
    expect(root.children.map((node) => node.tag)).toEqual([
      'h1',
      'p',
      'svg',
      'p',
      'ul',
      'p',
      'p',
      'svg',
      'svg',
    ]);
    const captions = root.children.slice(5, 7);
    expect(captions.map((p) => p.children.map((node) => node.tag))).toEqual([
      ['svg', 'span'],
      ['svg', 'span'],
    ]);
    expect(captions.map((p) => p.children[1]?.textContent)).toEqual([
      ' К 3 октября: 450.00 RSD',
      ' К 3 сентября: 600.00 RSD',
    ]);
    // Each swatch's fill is its line's stroke.
    const swatchFill = (p: FakeNode | undefined) =>
      p
        ?.all()
        .find((node) => node.tag === 'rect')
        ?.attributes.get('fill');
    expect(swatchFill(captions[0])).toBe(lines[1]?.attributes.get('stroke'));
    expect(swatchFill(captions[1])).toBe(lines[0]?.attributes.get('stroke'));
  });

  it('keeps every point inside the viewBox, the previous line ending at its top', async () => {
    const { lines, chart } = await pacePage({
      ...PACE,
      days: 31,
      current: Array.from({ length: 15 }, (_, i) => (i + 1) * 3000),
      previous: Array.from({ length: 30 }, (_, i) => (i + 1) * 3000),
    });

    expect(chart?.attributes.get('viewBox')).toBe('0 0 320 160');
    const [previous, current] = lines.map(pointsOf);
    for (const [x = NaN, y = NaN] of [...(previous ?? []), ...(current ?? [])]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(320);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(160);
    }
    // 90000 is the top; the current line's 45000 is halfway up.
    expect(previous?.at(-1)?.[1]).toBe(0);
    expect(current?.at(-1)?.[1]).toBe(80);
    expect(previous?.[0]).toEqual([0, 160]);
    expect(current).toHaveLength(16);
  });

  it('spans the x-axis over a previous period longer than the shown one', async () => {
    const { lines } = await pacePage({
      ...PACE,
      days: 30,
      current: [100],
      previous: Array.from({ length: 31 }, () => 100),
    });

    expect(pointsOf(lines[0]).at(-1)).toEqual([320, 0]);
  });

  it('puts a markup-like caption in the DOM as text only', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const { root } = await pacePage({ ...PACE, captions: [name] });

    expect(root.all().filter((node) => node.tag === 'img')).toEqual([]);
    expect(root.all().map((node) => node.textContent)).toContain(` ${name}`);
  });

  it('draws a v2 payload without a pace section as before', async () => {
    const { root } = await pacePage({ k: 'nope' });

    expect(root.all().filter((node) => node.tag === 'polyline')).toEqual([]);
    expect(root.children.map((node) => node.tag)).toEqual(['h1', 'p', 'svg', 'p', 'ul', 'svg']);
  });

  describe('a budget burn-down', () => {
    const BUDGET = {
      k: 'pace',
      days: 30,
      current: Array.from({ length: 13 }, (_, i) => (i === 12 ? 3500000 : 100000 * (i + 1))),
      limit: [3000000, 'Лимит: 30 000.00 RSD'],
      captions: ['Потрачено к 7 октября: 35 000.00 RSD', 'Сегодня перерасход 22 000.00 RSD'],
    };
    const budgetPage = async (theme: ChartTheme = {}) => {
      const root = new FakeNode('body');
      const hash = `#z=${await deflated({ v: 2, title: 'Бюджет: 25 сен – 24 окт', sections: [BUDGET] })}`;
      await showChart(fakeDocument(), root, hash, theme);
      return { root, lines: root.all().filter((node) => node.tag === 'polyline') };
    };

    it('draws the allowance dashed in the hint colour, the spend ending at the top above its end', async () => {
      const { root, lines } = await budgetPage({ button: '#5288c1', hint: '#708499' });

      const [allowance, spend] = lines;
      expect(lines).toHaveLength(2);
      expect(allowance?.attributes.get('stroke')).toBe('#708499');
      expect(allowance?.attributes.get('stroke-dasharray')).toBe('6 4');
      expect(spend?.attributes.get('stroke')).toBe('#5288c1');
      expect(spend?.attributes.has('stroke-dasharray')).toBe(false);
      // From (0, 0) to (30 days, the limit): 3000000 of the 3500000 top.
      expect(pointsOf(allowance)).toEqual([
        [0, 160],
        [320, 22.86],
      ]);
      const last = pointsOf(spend).at(-1);
      expect(last).toEqual([138.67, 0]);
      for (const [x = NaN, y = NaN] of pointsOf(spend)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(320);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(160);
      }
      // Under the title: the three captions, then the chart.
      expect(root.children.map((node) => node.tag)).toEqual(['h1', 'p', 'p', 'p', 'svg']);
      const captions = root.children.slice(1, 4);
      expect(captions.map((p) => p.children[1]?.textContent)).toEqual([
        ' Потрачено к 7 октября: 35 000.00 RSD',
        ' Сегодня перерасход 22 000.00 RSD',
        ' Лимит: 30 000.00 RSD',
      ]);
      const swatchFill = (p: FakeNode | undefined) =>
        p
          ?.all()
          .find((node) => node.tag === 'rect')
          ?.attributes.get('fill');
      expect(captions.map(swatchFill)).toEqual(['#5288c1', '#708499', '#708499']);
    });

    it('puts the limit at the top when the spend is under it', async () => {
      const root = new FakeNode('body');
      const under = { ...BUDGET, current: [1000000] };
      await showChart(
        fakeDocument(),
        root,
        `#z=${await deflated({ v: 2, title: 'Бюджет', sections: [under] })}`,
      );
      const [allowance] = root.all().filter((node) => node.tag === 'polyline');

      expect(pointsOf(allowance).at(-1)).toEqual([320, 0]);
    });

    it('rejects a limit of the wrong shape', async () => {
      for (const limit of [[0, 'Лимит'], [1.5, 'Лимит'], [3000000], [3000000, 5]]) {
        const hash = `#z=${await deflated({ v: 2, title: 'Бюджет', sections: [{ ...BUDGET, limit }] })}`;
        expect(await decodeChartPayload(hash)).toBe(undefined);
      }
    });
  });

  it('rejects a pace of the wrong shape', async () => {
    const broken = [
      { ...PACE, days: 0 },
      { ...PACE, days: 2 },
      { ...PACE, current: [1.5] },
      { ...PACE, previous: ['1'] },
      { ...PACE, captions: [] },
      { ...PACE, captions: ['a', 'b', 'c'] },
    ];
    for (const pace of broken) {
      expect(
        await decodeChartPayload(`#z=${await deflated({ ...OCTOBER, sections: [pace] })}`),
      ).toBe(undefined);
    }
  });
});

describe('the trend bars', () => {
  const TREND = [
    ['Май', 12500, '125.00 RSD'],
    ['Июнь', 0, '0.00 RSD'],
    ['Июль', 0, '0.00 RSD'],
    ['Август', 40000, '400.00 RSD'],
    ['Сентябрь', 160000, '1 600.00 RSD'],
    ['Октябрь', 34500, '345.00 RSD'],
  ];
  // The nodes of the trend's svg, drawn by the whole page.
  const trendPage = async (hash: string, theme: ChartTheme = {}) => {
    const root = new FakeNode('body');
    await showChart(fakeDocument(), root, hash, theme);
    const trend = root.children.find((node) =>
      node.attributes.get('viewBox')?.startsWith('0 0 320 '),
    );
    return trend?.all().slice(1) ?? [];
  };

  it('draws 6 bars oldest first, a period with nothing spent as a zero-length bar with its name', async () => {
    const nodes = await trendPage(`#d=${encoded({ ...SEPTEMBER, trend: TREND })}`);

    const bars = nodes.filter((node) => node.tag === 'rect');
    // In proportion to the largest total, 160000, across the full 320-unit width.
    expect(bars.map((bar) => bar.attributes.get('width'))).toEqual([
      '25',
      '0',
      '0',
      '80',
      '320',
      '69',
    ]);
    expect(nodes.filter((node) => node.tag === 'text').map((node) => node.textContent)).toEqual([
      'Май · 125.00 RSD',
      'Июнь · 0.00 RSD',
      'Июль · 0.00 RSD',
      'Август · 400.00 RSD',
      'Сентябрь · 1 600.00 RSD',
      'Октябрь · 345.00 RSD',
    ]);
  });

  it('starts every row text, amount included, at x 0, so a long amount cannot pass the viewBox', () => {
    const trend = [
      ['Август', 0, '0.00 RSD'],
      ['Сентябрь', 123456789, '≈ 1 234 567.89 RSD'],
    ] as const;
    const nodes = drawTrend(fakeDocument(), trend).all().slice(1);

    const texts = nodes.filter((node) => node.tag === 'text');
    expect(texts.map((node) => node.textContent)).toEqual([
      'Август · 0.00 RSD',
      'Сентябрь · ≈ 1 234 567.89 RSD',
    ]);
    expect(texts.map((node) => node.attributes.get('x'))).toEqual(['0', '0']);
    expect(
      nodes.filter((node) => node.tag === 'rect').map((bar) => bar.attributes.get('x')),
    ).toEqual(['0', '0']);
  });

  it('draws the shown period in the button colour and earlier ones at half opacity', async () => {
    const bars = async (theme: ChartTheme) =>
      (await trendPage(`#d=${encoded({ ...SEPTEMBER, trend: TREND })}`, theme)).filter(
        (node) => node.tag === 'rect',
      );

    const themed = await bars({ button: '#5288c1' });
    expect(themed.map((bar) => bar.attributes.get('fill'))).toEqual(Array(6).fill('#5288c1'));
    expect(themed.map((bar) => bar.attributes.get('opacity'))).toEqual([
      '0.5',
      '0.5',
      '0.5',
      '0.5',
      '0.5',
      undefined,
    ]);
    expect((await bars({})).at(-1)?.attributes.get('fill')).toBe('#2481cc');
  });

  it('draws nothing without a trend or for a hash the page cannot read', async () => {
    expect(await trendPage(`#d=${encoded(SEPTEMBER)}`)).toEqual([]);
    expect(await trendPage(`#d=${encoded({ ...SEPTEMBER, trend: [] })}`)).toEqual([]);
    expect(await trendPage('#d=!!!')).toEqual([]);
  });
});

describe('the bars section', () => {
  const PRICE = {
    k: 'bars',
    caption: 'Цена за 1 л',
    rows: [
      ['Июль 2026', 12990, '129.90 RSD/л'],
      ['Август 2026', null, 'размер не указан'],
      ['Сентябрь 2026', 13490, '134.90 RSD/л'],
    ],
    notes: ['Июнь 2026: 1.50 EUR · 1 л · 1.50 EUR/л'],
  };
  const SPEND = {
    k: 'bars',
    caption: 'Траты по месяцам',
    rows: [
      ['Июль 2026', 25980, '259.80 RSD'],
      ['Август 2026', 15000, '150.00 RSD'],
      ['Сентябрь 2026', 13490, '134.90 RSD'],
    ],
  };
  const MILK = { v: 2, title: 'Молоко', sections: [PRICE, SPEND] };

  it('reads bars with a null row, and rejects a row or a note of the wrong shape', async () => {
    expect(await decodeChartPayload(`#z=${await deflated(MILK)}`)).toEqual(MILK);
    for (const bad of [
      { ...PRICE, rows: [['Июль 2026', 129.9, '129.90 RSD/л']] },
      { ...PRICE, rows: [['Июль 2026', '12990', '129.90 RSD/л']] },
      { ...PRICE, rows: [['Июль 2026', 12990]] },
      { ...PRICE, notes: [1] },
      { ...PRICE, caption: undefined },
    ]) {
      expect(await decodeChartPayload(`#z=${await deflated({ ...MILK, sections: [bad] })}`)).toBe(
        undefined,
      );
    }
  });

  it('draws each section as its caption, its rows and its notes; a null row has no rect', async () => {
    const { root, texts } = await page(`#z=${await deflated(MILK)}`);

    expect(root.children.map((node) => node.tag)).toEqual(['h1', 'p', 'svg', 'p', 'p', 'svg']);
    expect(texts).toEqual([
      'Молоко',
      'Цена за 1 л',
      'Июль 2026',
      '129.90 RSD/л',
      'Август 2026',
      'размер не указан',
      'Сентябрь 2026',
      '134.90 RSD/л',
      'Июнь 2026: 1.50 EUR · 1 л · 1.50 EUR/л',
      'Траты по месяцам',
      'Июль 2026',
      '259.80 RSD',
      'Август 2026',
      '150.00 RSD',
      'Сентябрь 2026',
      '134.90 RSD',
    ]);
    const price = root.children[2];
    // Row 2 (y 30 to 60) holds the null row: its label and text, and no rect.
    const august = price?.children.filter((node) => {
      const y = Number(node.attributes.get('y'));
      return y >= 30 && y < 60;
    });
    expect(august?.map((node) => [node.tag, node.textContent])).toEqual([
      ['text', 'Август 2026'],
      ['text', 'размер не указан'],
    ]);
    // In proportion to the largest price, 13490, across the full 320-unit width.
    const bars = price?.children.filter((node) => node.tag === 'rect');
    expect(bars?.map((bar) => [bar.attributes.get('y'), bar.attributes.get('width')])).toEqual([
      ['16', '308.14'],
      ['76', '320'],
    ]);
    const spend = root.children[5]?.children.filter((node) => node.tag === 'rect');
    expect(spend?.map((bar) => bar.attributes.get('width'))).toEqual(['320', '184.76', '166.16']);
  });

  it('starts each label at x 0 and ends each text at the right edge', () => {
    const [, svg] = drawBars(fakeDocument(), {
      k: 'bars',
      caption: 'Цена за 1 л',
      rows: [['Июль 2026', 12990, '129.90 RSD/л']],
    });
    const texts = svg?.children.filter((node) => node.tag === 'text');

    expect(
      texts?.map((node) => [node.attributes.get('x'), node.attributes.get('text-anchor')]),
    ).toEqual([
      ['0', undefined],
      ['320', 'end'],
    ]);
  });
});

describe('the chart page', () => {
  it('draws a v1 d payload as before: one slice per line, and each rateless currency as one line', async () => {
    const { nodes, tags, texts } = await page(
      `#d=${encoded({ ...SEPTEMBER, unconverted: ['Без курса НБС: 12.50 EUR'] })}`,
    );

    const slices = nodes.filter((node) => node.tag === 'path');
    expect(slices).toHaveLength(2);
    // Еда is 120000 of 150000: its slice spans 0° to 288° clockwise from 12 o'clock, out along
    // the outer arc (radius 1) and back along the inner one (radius 0.6).
    expect(slices[0]?.attributes.get('d')).toBe(
      'M 0 -1 A 1 1 0 1 1 -0.9511 -0.309 L -0.5706 -0.1854 A 0.6 0.6 0 1 0 0 -0.6 Z',
    );
    expect(slices[1]?.attributes.get('d')).toBe(
      'M -0.9511 -0.309 A 1 1 0 0 1 0 -1 L 0 -0.6 A 0.6 0.6 0 0 0 -0.5706 -0.1854 Z',
    );
    expect(texts).toEqual([
      'Сентябрь 2026',
      '1 500.00 RSD',
      '1 500.00 RSD',
      'Всего',
      messages.chartTapHint,
      ' Еда: 1 200.00 RSD',
      ' Транспорт: 300.00 RSD',
      'Без курса НБС: 12.50 EUR',
    ]);
    expect(tags.at(-1)).toBe('p');
  });

  it('draws a single positive line as a full ring, not a sector', async () => {
    const { nodes } = await page(
      `#d=${encoded({
        ...SEPTEMBER,
        lines: [
          ['Еда', 150000, '1 500.00 RSD'],
          ['Транспорт', 0, '0.00 RSD'],
        ],
      })}`,
    );

    const slices = nodes.filter((node) => node.tag === 'path');
    expect(slices).toHaveLength(1);
    expect(slices[0]?.attributes.get('d')).toBe(
      'M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z ' +
        'M 0 -0.6 A 0.6 0.6 0 1 1 0 0.6 A 0.6 0.6 0 1 1 0 -0.6 Z',
    );
    expect(slices[0]?.attributes.get('fill-rule')).toBe('evenodd');
  });

  it('puts the total and its caption in the hole, squeezing a centre text past 12 characters', async () => {
    const centre = async (totalLabel: string) => {
      const { nodes } = await page(`#d=${encoded({ ...SEPTEMBER, totalLabel })}`);
      const donut = nodes.find(
        (node) => node.tag === 'svg' && node.attributes.get('role') === 'img',
      );
      return donut?.children.filter((node) => node.tag === 'text') ?? [];
    };

    const long = await centre('≈ 1 234 567.89 RSD');
    expect(long.map((node) => node.textContent)).toEqual(['≈ 1 234 567.89 RSD', 'Всего']);
    expect(long[0]?.attributes.get('textLength')).toBe('1.1');
    expect(long[0]?.attributes.get('lengthAdjust')).toBe('spacingAndGlyphs');
    expect(long[1]?.attributes.has('textLength')).toBe(false);

    const usual = await centre('45 230.00 RSD');
    expect(usual.map((node) => node.textContent)).toEqual(['45 230.00 RSD', 'Всего']);
    expect(usual[0]?.attributes.get('textLength')).toBe('1.1');
    expect(usual[1]?.attributes.has('textLength')).toBe(false);
  });

  it('scales the donut and the trend to the page width, through CSSOM only', async () => {
    const hash = `#d=${encoded({ ...SEPTEMBER, trend: [['Сентябрь', 150000, '1 500.00 RSD']] })}`;
    const { root, nodes } = await page(hash);

    const donut = nodes.find((node) => node.attributes.get('role') === 'img');
    expect(donut?.tag).toBe('svg');
    expect(donut?.attributes.get('aria-label')).toBe('Сентябрь 2026: 1 500.00 RSD');
    expect(donut?.attributes.get('width')).toBe('100%');
    expect(donut?.attributes.get('viewBox')).toBe('-1.02 -1.02 2.04 2.04');
    expect(donut?.style.maxWidth).toBe('360px');
    const trend = root.children.at(-1);
    expect(trend?.tag).toBe('svg');
    expect(trend?.attributes.get('width')).toBe('100%');
    expect(trend?.attributes.get('viewBox')).toBe('0 0 320 30');
    // The fake throws on a style attribute, so getting here means none was set; this says so.
    expect(nodes.some((node) => node.attributes.has('style'))).toBe(false);
  });

  it('titles the page «Диаграмма» in chart mode, fallbacks included', async () => {
    expect((await page(`#d=${encoded(SEPTEMBER)}`)).doc.title).toBe('Диаграмма');
    expect((await page('#d=!!!')).doc.title).toBe('Диаграмма');
  });

  it.each([
    ['an unknown version', `#d=${base64url(JSON.stringify({ v: 2 }))}`, messages.chartBroken],
    ['broken base64', '#d=!!!', messages.chartBroken],
    ['a missing d', '#tgWebAppVersion=8.0', messages.openFromBot],
  ])('shows only the fallback line for %s', async (_case, hash, fallback) => {
    const { tags, texts } = await page(hash);

    expect(tags).toEqual(['p']);
    expect(texts).toEqual([fallback]);
  });

  it('puts a category name in the DOM as text only, never as an element', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const { nodes, texts } = await page(
      `#d=${encoded({ ...SEPTEMBER, lines: [[name, 5000, '50.00 RSD']], totalMinor: 5000, totalLabel: '50.00 RSD' })}`,
    );

    expect(nodes.filter((node) => node.tag === 'img')).toEqual([]);
    expect(texts).toContain(` ${name}: 50.00 RSD`);
  });
});

describe('the theme', () => {
  const fills = (nodes: FakeNode[], tag: string) =>
    nodes.filter((node) => node.tag === tag).map((node) => node.attributes.get('fill'));
  const themed = async (bg: string | undefined, payload: object = SEPTEMBER) => {
    const root = new FakeNode('body');
    const params: { bg_color?: string; hint_color?: string } = {};
    if (bg !== undefined) params.bg_color = bg;
    await startChart(fakeDocument(), root, `#d=${encoded(payload)}`, { themeParams: params });
    return root.all();
  };

  it('draws slices from DARK on a black background, and from LIGHT on white or with no theme', async () => {
    expect(fills(await themed('#000000'), 'path')).toEqual([DARK[0], DARK[1]]);
    expect(fills(await themed('#ffffff'), 'path')).toEqual([LIGHT[0], LIGHT[1]]);
    expect(fills(await themed(undefined), 'path')).toEqual([LIGHT[0], LIGHT[1]]);
  });

  it('draws lines past the eighth in the hint colour, in the slices and the legend swatches', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => [`Категория ${i + 1}`, 1000, '10.00 RSD']);
    const payload = { ...SEPTEMBER, lines, totalMinor: 10000 };
    const nodes = await themed(undefined, payload);

    expect(fills(nodes, 'path')).toEqual([...LIGHT, '#999999', '#999999']);
    expect(fills(nodes, 'rect')).toEqual([...LIGHT, '#999999', '#999999']);

    const root = new FakeNode('body');
    const webApp = { themeParams: { hint_color: '#708499' } };
    await startChart(fakeDocument(), root, `#d=${encoded(payload)}`, webApp);
    expect(fills(root.all(), 'path').slice(8)).toEqual(['#708499', '#708499']);
    expect(fills(root.all(), 'rect').slice(8)).toEqual(['#708499', '#708499']);
  });

  it('redraws from the other palette on themeChanged, without duplicating the page', async () => {
    const params = { bg_color: '#ffffff', text_color: '#000000' };
    const handlers: (() => void)[] = [];
    const expand = vi.fn();
    const webApp: ChartWebApp = {
      themeParams: params,
      expand,
      onEvent: (_event, handler) => handlers.push(handler),
    };
    const root = new FakeNode('body');
    const hash = `#d=${encoded({ ...SEPTEMBER, trend: [['Сентябрь', 150000, '1 500.00 RSD']] })}`;
    await startChart(fakeDocument(), root, hash, webApp);
    const before = root.all().map((node) => node.tag);
    expect(fills(root.all(), 'path')).toEqual([LIGHT[0], LIGHT[1]]);
    expect(root.style.backgroundColor).toBe('#ffffff');
    expect(expand).toHaveBeenCalledTimes(1);

    params.bg_color = '#000000';
    params.text_color = '#ffffff';
    for (const handler of handlers) handler();

    expect(fills(root.all(), 'path')).toEqual([DARK[0], DARK[1]]);
    expect(root.all().map((node) => node.tag)).toEqual(before);
    expect(root.children.filter((node) => node.tag === 'h1')).toHaveLength(1);
    expect(root.style.backgroundColor).toBe('#000000');
    expect(root.style.color).toBe('#ffffff');
  });
});

describe('inspecting a line', () => {
  const inspectable = async (payload: object = SEPTEMBER, onSelect: () => void = () => {}) => {
    const { root, nodes } = await page(`#d=${encoded(payload)}`, onSelect);
    const donut = nodes.find((node) => node.attributes.get('role') === 'img');
    return {
      root,
      nodes,
      slices: nodes.filter((node) => node.tag === 'path'),
      rows: nodes.filter((node) => node.tag === 'li'),
      hole: donut?.children.find((node) => node.tag === 'circle'),
      centre: () =>
        donut?.children.filter((node) => node.tag === 'text').map((node) => node.textContent),
    };
  };
  const opacities = (slices: FakeNode[]) => slices.map((slice) => slice.attributes.get('opacity'));

  it('dims the other slices and shows the line in the centre, and a second tap clears it', async () => {
    const { slices, rows, centre } = await inspectable();

    rows[1]?.click();
    expect(opacities(slices)).toEqual(['0.35', '1']);
    expect(centre()).toEqual(['Транспорт', '300.00 RSD']);
    expect(rows.map((row) => row.style.fontWeight)).toEqual(['', 'bold']);

    rows[1]?.click();
    expect(opacities(slices)).toEqual(['1', '1']);
    expect(centre()).toEqual(['1 500.00 RSD', 'Всего']);
    expect(rows.map((row) => row.style.fontWeight)).toEqual(['', '']);
  });

  it('selects the same line from its slice as from its legend row, and the hole clears it', async () => {
    const { slices, rows, hole, centre } = await inspectable();

    slices[1]?.click();
    expect(opacities(slices)).toEqual(['0.35', '1']);
    expect(centre()).toEqual(['Транспорт', '300.00 RSD']);
    expect(rows[1]?.style.fontWeight).toBe('bold');

    slices[0]?.click();
    expect(opacities(slices)).toEqual(['1', '0.35']);
    expect(centre()).toEqual(['Еда', '1 200.00 RSD']);

    hole?.click();
    expect(opacities(slices)).toEqual(['1', '1']);
    expect(centre()).toEqual(['1 500.00 RSD', 'Всего']);
  });

  it('cuts a long name in the centre and keeps it whole in the legend', async () => {
    const name = 'Развлечения и подписки';
    const { rows, centre } = await inspectable({
      ...SEPTEMBER,
      lines: [
        ['Еда', 120000, '1 200.00 RSD'],
        [name, 30000, '300.00 RSD'],
      ],
    });

    rows[1]?.click();
    expect(centre()).toEqual(['Развлечения и…', '300.00 RSD']);
    expect(rows[1]?.all().map((node) => node.textContent)).toContain(` ${name}: 300.00 RSD`);
  });

  it('lets a zero-amount line, which has no slice, be selected from its legend row', async () => {
    const { slices, rows, centre } = await inspectable({
      ...SEPTEMBER,
      lines: [...SEPTEMBER.lines, ['Связь', 0, '0.00 RSD']],
    });

    rows[2]?.click();
    expect(centre()).toEqual(['Связь', '0.00 RSD']);
    expect(opacities(slices)).toEqual(['0.35', '0.35']);
  });

  it('shows the tap hint once, under the donut, and gives every legend row a 44px tap height', async () => {
    const { root, rows } = await inspectable();

    const tags = root.children.map((node) => node.tag);
    const hint = root.children.filter((node) => node.textContent === messages.chartTapHint);
    expect(hint).toHaveLength(1);
    expect(hint[0]?.tag).toBe('p');
    expect(root.children.indexOf(hint[0] ?? root)).toBe(tags.indexOf('svg') + 1);
    expect(rows.map((row) => row.style.minHeight)).toEqual(['44px', '44px']);
  });

  it('puts a selected markup-like name in the centre as text only', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const { nodes, rows, centre } = await inspectable({
      ...SEPTEMBER,
      lines: [
        ['Еда', 120000, '1 200.00 RSD'],
        [name, 30000, '300.00 RSD'],
      ],
    });

    rows[1]?.click();
    // 28 characters: the centre holds its first 14, as text.
    expect(centre()).toEqual(['<img src=x one…', '300.00 RSD']);
    expect(nodes.filter((node) => node.tag === 'img')).toEqual([]);
  });

  describe('the history panel', () => {
    const PERIODS = ['Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь'];
    const PIE = {
      ...OCTOBER_PIE,
      totalMinor: 157000,
      totalLabel: '1 570.00 RSD',
      lines: [...OCTOBER_PIE.lines, ['Прочее', 2000, '20.00 RSD', '1%']],
    };
    const amounts = (values: number[]) => values.map((value) => [value, `${value / 100}.00 RSD`]);
    // Еда and Кафе keep their series; Транспорт's was shed, and «Прочее» has none.
    const CAT_TREND = {
      k: 'catTrend',
      caption: 'Последние 6 месяцев',
      periods: PERIODS,
      series: [
        [0, amounts([0, 0, 90000, 100000, 110000, 120000])],
        [2, amounts([0, 0, 4000, 0, 0, 5000])],
      ],
    };
    const historyPage = async (sections: object[]) => {
      const { nodes } = await page(`#z=${await deflated({ ...OCTOBER, sections })}`);
      const legend = nodes.find((node) => node.tag === 'ul');
      const rows = legend?.children.slice() ?? [];
      const slices = nodes.filter((node) => node.tag === 'path');
      // The legend's children past the rows: the open panel, with where it sits.
      const panel = () => {
        const children = legend?.children ?? [];
        const index = children.findIndex((child) => !rows.includes(child));
        return index < 0 ? undefined : { after: children[index - 1], node: children[index] };
      };
      return { rows, slices, legend, panel };
    };

    it('opens under the Кафе row from the row or the slice: «Кафе», the caption, and 6 bars', async () => {
      const { rows, slices, panel } = await historyPage([PIE, OCTOBER_TREND, CAT_TREND]);

      rows[2]?.click();
      const opened = panel();
      expect(opened?.after).toBe(rows[2]);
      expect(opened?.node?.children.map((node) => node.tag)).toEqual(['h2', 'p', 'svg']);
      expect(opened?.node?.children.slice(0, 2).map((node) => node.textContent)).toEqual([
        'Кафе',
        'Последние 6 месяцев',
      ]);
      const svg = opened?.node?.children[2];
      expect(svg?.children.filter((node) => node.tag === 'rect')).toHaveLength(6);
      expect(
        svg?.children.filter((node) => node.tag === 'text').map((node) => node.textContent),
      ).toEqual([
        'Май · 0.00 RSD',
        'Июнь · 0.00 RSD',
        'Июль · 40.00 RSD',
        'Август · 0.00 RSD',
        'Сентябрь · 0.00 RSD',
        'Октябрь · 50.00 RSD',
      ]);

      rows[2]?.click();
      expect(panel()).toBeUndefined();

      slices[2]?.click();
      expect(panel()?.after).toBe(rows[2]);
      expect(panel()?.node?.children[0]?.textContent).toBe('Кафе');
    });

    it('closes on a second tap and moves under another row', async () => {
      const { rows, legend, panel } = await historyPage([PIE, CAT_TREND]);

      rows[2]?.click();
      rows[0]?.click();

      expect(panel()?.after).toBe(rows[0]);
      expect(panel()?.node?.children[0]?.textContent).toBe('Еда');
      expect(legend?.children).toHaveLength(rows.length + 1);

      rows[0]?.click();
      expect(legend?.children).toEqual(rows);
    });

    it('shows chartNoHistory and no bars for «Прочее» and for a line whose series was shed', async () => {
      const { rows, panel } = await historyPage([PIE, CAT_TREND]);

      for (const [index, name] of [
        [3, 'Прочее'],
        [1, 'Транспорт'],
      ] as const) {
        rows[index]?.click();
        expect(panel()?.after).toBe(rows[index]);
        expect(panel()?.node?.children.map((node) => [node.tag, node.textContent])).toEqual([
          ['h2', name],
          ['p', messages.chartNoHistory],
        ]);
      }
    });

    it('selects a line and opens no panel without a catTrend section', async () => {
      const { rows, legend, panel } = await historyPage([PIE, OCTOBER_TREND]);

      rows[2]?.click();

      expect(rows[2]?.style.fontWeight).toBe('bold');
      expect(panel()).toBeUndefined();
      expect(legend?.children).toEqual(rows);
    });

    it('puts markup-like labels in the panel as text only', async () => {
      const name = '<img src=x onerror=alert(1)>';
      const pie = { ...PIE, lines: [[name, 157000, '1 570.00 RSD', '100%']] };
      const catTrend = {
        ...CAT_TREND,
        caption: '<b>caption</b>',
        periods: PERIODS.map(() => '<i>period</i>'),
        series: [[0, PERIODS.map(() => [1, '<script>x</script>'])]],
      };
      const { rows, panel } = await historyPage([pie, catTrend]);

      rows[0]?.click();

      const nodes = panel()?.node?.all() ?? [];
      expect(nodes.filter((node) => ['img', 'b', 'i', 'script'].includes(node.tag))).toEqual([]);
      expect(nodes.map((node) => node.textContent)).toEqual(
        expect.arrayContaining([name, '<b>caption</b>', '<i>period</i> · <script>x</script>']),
      );
    });

    it('rejects a catTrend of the wrong shape', async () => {
      const broken = [
        { ...CAT_TREND, caption: 6 },
        { ...CAT_TREND, periods: [1] },
        { ...CAT_TREND, series: [[-1, amounts([0, 0, 0, 0, 0, 0])]] },
        { ...CAT_TREND, series: [[0, amounts([0, 0, 0, 0, 0])]] },
        { ...CAT_TREND, series: [[0, [[1.5, 'x'], ...amounts([0, 0, 0, 0, 0])]]] },
      ];
      for (const catTrend of broken) {
        const hash = `#z=${await deflated({ ...OCTOBER, sections: [PIE, catTrend] })}`;
        expect(await decodeChartPayload(hash)).toBe(undefined);
      }
    });
  });

  it('reports each selection change, and stores or sends nothing', async () => {
    const fetch = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('localStorage', { setItem });
    vi.stubGlobal('sessionStorage', { setItem });
    const onSelect = vi.fn();
    try {
      const { rows } = await inspectable(SEPTEMBER, onSelect);

      rows[0]?.click();
      rows[1]?.click();
      rows[1]?.click();
      expect(onSelect).toHaveBeenCalledTimes(3);
      expect(fetch).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
