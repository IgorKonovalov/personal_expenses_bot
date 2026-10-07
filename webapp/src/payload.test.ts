import { describe, expect, it, vi } from 'vitest';
import { showTrend } from './bars.js';
import { messages } from './messages.js';
import { decodeChartPayload } from './payload.js';
import { showChart, type ChartDocument, type ChartNode, type ChartStyle } from './pie.js';

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

function page(hash: string, onSelect: () => void = () => {}) {
  const doc = fakeDocument();
  const root = new FakeNode('body');
  showChart(doc, root, hash, {}, onSelect);
  const nodes = root.all().slice(1);
  return {
    doc,
    root,
    nodes,
    tags: nodes.map((node) => node.tag),
    texts: nodes.map((node) => node.textContent).filter((text) => text !== null),
  };
}

// base64url of UTF-8 text, as the bot's encoder writes it (src/domain/chartPayload.ts, whose
// round trip through decodeChartPayload is tested there).
function base64url(text: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(text));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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
  it('reads d next to the launch parameters Telegram appends', () => {
    const d = encoded(SEPTEMBER);

    expect(decodeChartPayload(`#tgWebAppVersion=8.0&d=${d}&tgWebAppPlatform=ios`)).toEqual(
      SEPTEMBER,
    );
  });

  it('rejects an unknown version, broken base64 or JSON, a missing d, and lines off the total', () => {
    const valid = SEPTEMBER;

    expect(decodeChartPayload(`#d=${base64url(JSON.stringify({ ...valid, v: 2 }))}`)).toBe(
      undefined,
    );
    expect(decodeChartPayload('#d=%%%not-base64')).toBe(undefined);
    expect(decodeChartPayload(`#d=${base64url('{"v":1,')}`)).toBe(undefined);
    expect(decodeChartPayload('#tgWebAppVersion=8.0')).toBe(undefined);
    expect(decodeChartPayload('')).toBe(undefined);
    expect(
      decodeChartPayload(`#d=${base64url(JSON.stringify({ ...valid, totalMinor: 150001 }))}`),
    ).toBe(undefined);
    expect(
      decodeChartPayload(
        `#d=${base64url(JSON.stringify({ ...valid, lines: [['Еда', 1.5, '0.02 RSD']], totalMinor: 1.5 }))}`,
      ),
    ).toBe(undefined);
  });

  it('reads a trend, and rejects a trend bar of the wrong shape', () => {
    const trend = [
      ['Август', 0, '0.00 RSD'],
      ['Сентябрь', 150000, '1 500.00 RSD'],
    ];

    expect(decodeChartPayload(`#d=${encoded({ ...SEPTEMBER, trend })}`)?.trend).toEqual(trend);
    expect(
      decodeChartPayload(`#d=${encoded({ ...SEPTEMBER, trend: [['Август', 0.5, '']] })}`),
    ).toBe(undefined);
    expect(decodeChartPayload(`#d=${encoded({ ...SEPTEMBER, trend: 'Август' })}`)).toBe(undefined);
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
  const trendPage = (hash: string) => {
    const root = new FakeNode('body');
    showTrend(fakeDocument(), root, hash);
    return root.all().slice(1);
  };

  it('draws 6 bars oldest first, a period with nothing spent as a zero-length bar with its name', () => {
    const nodes = trendPage(`#d=${encoded({ ...SEPTEMBER, trend: TREND })}`);

    const bars = nodes.filter((node) => node.tag === 'rect');
    expect(bars.map((bar) => bar.attributes.get('width'))).toEqual([
      '8.59',
      '0',
      '0',
      '27.5',
      '110',
      '23.72',
    ]);
    expect(nodes.filter((node) => node.tag === 'text').map((node) => node.textContent)).toEqual([
      'Май',
      '125.00 RSD',
      'Июнь',
      '0.00 RSD',
      'Июль',
      '0.00 RSD',
      'Август',
      '400.00 RSD',
      'Сентябрь',
      '1 600.00 RSD',
      'Октябрь',
      '345.00 RSD',
    ]);
  });

  it('draws nothing without a trend or for a hash the page cannot read', () => {
    expect(trendPage(`#d=${encoded(SEPTEMBER)}`)).toEqual([]);
    expect(trendPage('#d=!!!')).toEqual([]);
  });
});

describe('the chart page', () => {
  it('draws one slice per line of the converted block, and each rateless currency as one line', () => {
    const { nodes, tags, texts } = page(
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

  it('draws a single positive line as a full ring, not a sector', () => {
    const { nodes } = page(
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

  it('puts the total and its caption in the hole, squeezing a centre text past 12 characters', () => {
    const centre = (totalLabel: string) => {
      const { nodes } = page(`#d=${encoded({ ...SEPTEMBER, totalLabel })}`);
      const donut = nodes.find(
        (node) => node.tag === 'svg' && node.attributes.get('role') === 'img',
      );
      return donut?.children.filter((node) => node.tag === 'text') ?? [];
    };

    const long = centre('≈ 1 234 567.89 RSD');
    expect(long.map((node) => node.textContent)).toEqual(['≈ 1 234 567.89 RSD', 'Всего']);
    expect(long[0]?.attributes.get('textLength')).toBe('1.1');
    expect(long[0]?.attributes.get('lengthAdjust')).toBe('spacingAndGlyphs');
    expect(long[1]?.attributes.has('textLength')).toBe(false);

    const usual = centre('45 230.00 RSD');
    expect(usual.map((node) => node.textContent)).toEqual(['45 230.00 RSD', 'Всего']);
    expect(usual[0]?.attributes.get('textLength')).toBe('1.1');
    expect(usual[1]?.attributes.has('textLength')).toBe(false);
  });

  it('scales the donut and the trend to the page width, through CSSOM only', () => {
    const hash = `#d=${encoded({ ...SEPTEMBER, trend: [['Сентябрь', 150000, '1 500.00 RSD']] })}`;
    const { doc, nodes } = page(hash);
    const root = new FakeNode('body');
    showTrend(doc, root, hash);

    const donut = nodes.find((node) => node.attributes.get('role') === 'img');
    expect(donut?.tag).toBe('svg');
    expect(donut?.attributes.get('aria-label')).toBe('Сентябрь 2026: 1 500.00 RSD');
    expect(donut?.attributes.get('width')).toBe('100%');
    expect(donut?.attributes.get('viewBox')).toBe('-1.02 -1.02 2.04 2.04');
    expect(donut?.style.maxWidth).toBe('360px');
    const trend = root.children[0];
    expect(trend?.tag).toBe('svg');
    expect(trend?.attributes.get('width')).toBe('100%');
    expect(trend?.attributes.get('viewBox')).toBe('0 0 320 24');
    // The fake throws on a style attribute, so getting here means none was set; this says so.
    expect([...nodes, ...root.all()].some((node) => node.attributes.has('style'))).toBe(false);
  });

  it('titles the page «Диаграмма» in chart mode, fallbacks included', () => {
    expect(page(`#d=${encoded(SEPTEMBER)}`).doc.title).toBe('Диаграмма');
    expect(page('#d=!!!').doc.title).toBe('Диаграмма');
  });

  it.each([
    ['an unknown version', `#d=${base64url(JSON.stringify({ v: 2 }))}`, messages.chartBroken],
    ['broken base64', '#d=!!!', messages.chartBroken],
    ['a missing d', '#tgWebAppVersion=8.0', messages.openFromBot],
  ])('shows only the fallback line for %s', (_case, hash, fallback) => {
    const { tags, texts } = page(hash);

    expect(tags).toEqual(['p']);
    expect(texts).toEqual([fallback]);
  });

  it('puts a category name in the DOM as text only, never as an element', () => {
    const name = '<img src=x onerror=alert(1)>';
    const { nodes, texts } = page(
      `#d=${encoded({ ...SEPTEMBER, lines: [[name, 5000, '50.00 RSD']], totalMinor: 5000, totalLabel: '50.00 RSD' })}`,
    );

    expect(nodes.filter((node) => node.tag === 'img')).toEqual([]);
    expect(texts).toContain(` ${name}: 50.00 RSD`);
  });
});

describe('inspecting a line', () => {
  const inspectable = (payload: object = SEPTEMBER, onSelect: () => void = () => {}) => {
    const { root, nodes } = page(`#d=${encoded(payload)}`, onSelect);
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

  it('dims the other slices and shows the line in the centre, and a second tap clears it', () => {
    const { slices, rows, centre } = inspectable();

    rows[1]?.click();
    expect(opacities(slices)).toEqual(['0.35', '1']);
    expect(centre()).toEqual(['Транспорт', '300.00 RSD']);
    expect(rows.map((row) => row.style.fontWeight)).toEqual(['', 'bold']);

    rows[1]?.click();
    expect(opacities(slices)).toEqual(['1', '1']);
    expect(centre()).toEqual(['1 500.00 RSD', 'Всего']);
    expect(rows.map((row) => row.style.fontWeight)).toEqual(['', '']);
  });

  it('selects the same line from its slice as from its legend row, and the hole clears it', () => {
    const { slices, rows, hole, centre } = inspectable();

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

  it('cuts a long name in the centre and keeps it whole in the legend', () => {
    const name = 'Развлечения и подписки';
    const { rows, centre } = inspectable({
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

  it('lets a zero-amount line, which has no slice, be selected from its legend row', () => {
    const { slices, rows, centre } = inspectable({
      ...SEPTEMBER,
      lines: [...SEPTEMBER.lines, ['Связь', 0, '0.00 RSD']],
    });

    rows[2]?.click();
    expect(centre()).toEqual(['Связь', '0.00 RSD']);
    expect(opacities(slices)).toEqual(['0.35', '0.35']);
  });

  it('shows the tap hint once, under the donut, and gives every legend row a 44px tap height', () => {
    const { root, rows } = inspectable();

    const tags = root.children.map((node) => node.tag);
    const hint = root.children.filter((node) => node.textContent === messages.chartTapHint);
    expect(hint).toHaveLength(1);
    expect(hint[0]?.tag).toBe('p');
    expect(root.children.indexOf(hint[0] ?? root)).toBe(tags.indexOf('svg') + 1);
    expect(rows.map((row) => row.style.minHeight)).toEqual(['44px', '44px']);
  });

  it('puts a selected markup-like name in the centre as text only', () => {
    const name = '<img src=x onerror=alert(1)>';
    const { nodes, rows, centre } = inspectable({
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

  it('reports each selection change, and stores or sends nothing', () => {
    const fetch = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('localStorage', { setItem });
    vi.stubGlobal('sessionStorage', { setItem });
    const onSelect = vi.fn();
    try {
      const { rows } = inspectable(SEPTEMBER, onSelect);

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
