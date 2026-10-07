import { describe, expect, it } from 'vitest';
import { messages } from './messages.js';
import { decodeChartPayload } from './payload.js';
import { showChart, type ChartDocument, type ChartNode } from './pie.js';

// A DOM stand-in: builds a tree from createElement/createElementNS and textContent alone. It has
// no markup parser, and assigning markup through innerHTML or outerHTML throws.
class FakeNode implements ChartNode<FakeNode> {
  textContent: string | null = null;
  readonly attributes = new Map<string, string>();
  readonly children: FakeNode[] = [];
  constructor(
    readonly tag: string,
    readonly namespace?: string,
  ) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
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

function page(hash: string) {
  const doc: ChartDocument<FakeNode> = {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag, namespace),
  };
  const root = new FakeNode('body');
  showChart(doc, root, hash);
  const nodes = root.all().slice(1);
  return {
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
});

describe('the chart page', () => {
  it('draws one slice per line of the converted block, and each rateless currency as one line', () => {
    const { nodes, tags, texts } = page(
      `#d=${encoded({ ...SEPTEMBER, unconverted: ['Без курса НБС: 12.50 EUR'] })}`,
    );

    const slices = nodes.filter((node) => node.tag === 'path');
    expect(slices).toHaveLength(2);
    // Еда is 120000 of 150000: its slice ends at 0.8 of the circle.
    expect(slices[0]?.attributes.get('d')).toBe('M 0 0 L 0 -1 A 1 1 0 1 1 -0.9511 -0.309 Z');
    expect(slices[1]?.attributes.get('d')).toBe('M 0 0 L -0.9511 -0.309 A 1 1 0 0 1 0 -1 Z');
    expect(texts).toEqual([
      'Сентябрь 2026',
      '1 500.00 RSD',
      ' Еда: 1 200.00 RSD',
      ' Транспорт: 300.00 RSD',
      'Без курса НБС: 12.50 EUR',
    ]);
    expect(tags.at(-1)).toBe('p');
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
