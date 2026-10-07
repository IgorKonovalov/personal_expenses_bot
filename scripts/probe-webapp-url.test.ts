import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeChartPayload } from '../webapp/src/payload.js';
import {
  showChart,
  type ChartDocument,
  type ChartNode,
  type ChartStyle,
} from '../webapp/src/pie.js';
import { PROBE_TARGETS, probePayload, runProbe } from './probe-webapp-url.js';

// A DOM stand-in holding only what the chart writes: tags, text and children.
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
  readonly children: FakeNode[] = [];
  constructor(readonly tag: string) {}
  setAttribute(): void {}
  removeAttribute(): void {}
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }
  addEventListener(): void {}
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const fakeDocument = (): ChartDocument<FakeNode> => ({
  title: '',
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_namespace, tag) => new FakeNode(tag),
});

describe('probePayload', () => {
  it.each(PROBE_TARGETS)('makes a z of %i characters or up to 64 fewer', (target) => {
    const z = probePayload(target);

    expect(z.length).toBeLessThanOrEqual(target);
    expect(z.length).toBeGreaterThanOrEqual(target - 64);
    expect(z).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(PROBE_TARGETS)(
    "decodes through the page's decoder to «Проба %i», drawn as a one-line pie",
    async (target) => {
      const hash = `#tgWebAppVersion=8.0&z=${probePayload(target)}`;

      const payload = await decodeChartPayload(hash);
      expect(payload?.title).toBe(`Проба ${target}`);
      const root = new FakeNode('body');
      await showChart(fakeDocument(), root, hash);
      const nodes = root.all();
      expect(nodes.find((node) => node.tag === 'h1')?.textContent).toBe(`Проба ${target}`);
      expect(nodes.filter((node) => node.tag === 'li')).toHaveLength(1);
      expect(nodes.filter((node) => node.tag === 'path')).toHaveLength(1);
    },
  );
});

describe('runProbe', () => {
  const ENV = {
    BOT_TOKEN: '123456:secret-token',
    ADMIN_TELEGRAM_ID: '42',
    WEBAPP_URL: 'https://example.github.io/bot/',
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A Bot API that refuses any message with a button longer than `limit` characters.
  const botApi = (limit: number) =>
    vi.fn((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        reply_markup: { inline_keyboard: { web_app: { url: string } }[][] };
      };
      const urls = body.reply_markup.inline_keyboard.flat().map((button) => button.web_app.url);
      const ok = urls.every((url) => url.length <= limit);
      return Promise.resolve(
        Response.json(ok ? { ok } : { ok, description: 'Bad Request: BUTTON_URL_INVALID' }),
      );
    });

  it('sends one message with every size when the Bot API takes it', async () => {
    const fetch = botApi(Infinity);
    vi.stubGlobal('fetch', fetch);
    const lines: string[] = [];

    expect(await runProbe(ENV, (line) => lines.push(line))).toBe(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['sent: 2048, 4096, 8192, 16384, 32768']);
  });

  it('sends the sizes it accepts alone and prints each refusal, never the token or a URL', async () => {
    vi.stubGlobal('fetch', botApi(9000));
    const lines: string[] = [];

    await runProbe(ENV, (line) => lines.push(line));

    expect(lines).toEqual([
      'refused together: Bad Request: BUTTON_URL_INVALID',
      'sent: 2048',
      'sent: 4096',
      'sent: 8192',
      'refused 16384: Bad Request: BUTTON_URL_INVALID',
      'refused 32768: Bad Request: BUTTON_URL_INVALID',
    ]);
    for (const line of lines) {
      expect(line).not.toContain('secret-token');
      expect(line).not.toContain('https:');
      expect(line).not.toContain('#z=');
    }
  });

  it('prints neither the token nor a URL when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.reject(new TypeError(`fetch failed: https://api.telegram.org/bot${ENV.BOT_TOKEN}`)),
      ),
    );
    const lines: string[] = [];

    expect(await runProbe(ENV, (line) => lines.push(line))).toBe(false);

    expect(lines).toEqual(['the request to the Bot API failed']);
  });

  it('names a missing variable and sends nothing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const lines: string[] = [];

    expect(await runProbe({ ...ENV, WEBAPP_URL: '' }, (line) => lines.push(line))).toBe(false);

    expect(lines).toEqual(['not set: WEBAPP_URL']);
    expect(fetch).not.toHaveBeenCalled();
  });
});
