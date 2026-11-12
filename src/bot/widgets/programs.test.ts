import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { GENERATED_PATH, PROGRAMS, generatedSource } from '../../../scripts/build-widgets.js';
import { encodeDonut, type DonutLine } from '../../domain/widgetData.js';
import { WIDGET_PROGRAMS, type WidgetProgram } from './programs.generated.js';

// Telegram's limits on a widget's HTML (ADR-0053): 32768 bytes, and 4096 bytes after zlib at
// level 9. Node's zlib can differ from the server's by a few dozen bytes either way, so a
// program near the gate is measured again with Python's zlib, which counts as the server does.
const MAX_HTML_BYTES = 32768;
const MAX_DEFLATED_BYTES = 4096;

describe('widget programs', () => {
  it.each(PROGRAMS)('%s fits the size limits', (name) => {
    const html = WIDGET_PROGRAMS[name];
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(MAX_HTML_BYTES);
    expect(deflateSync(html, { level: 9 }).length).toBeLessThanOrEqual(MAX_DEFLATED_BYTES);
  });

  it('the committed programs.generated.ts is what pnpm build:widgets writes', async () => {
    expect(readFileSync(GENERATED_PATH, 'utf8')).toBe(await generatedSource());
  });

  it('holds exactly the programs the build knows', () => {
    expect(Object.keys(WIDGET_PROGRAMS)).toEqual([...PROGRAMS]);
  });
});

// The DOM a program touches, no more: enough to run its built script in a vm and press what it
// drew.
class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
  innerHTML = '';
  id = '';
  style: Record<string, string> = {};
  onclick: ((event: { readonly target: unknown }) => void) | null = null;

  constructor(readonly tag: string) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = nodes;
  }

  // Every text below this element, in order.
  text(): string {
    return [this.textContent, ...this.children.map((child) => child.text())]
      .filter((part) => part !== '')
      .join(' ');
  }
}

type Request = (data: string) => Promise<{ readonly result: string | null }>;

// Runs `program`'s built script with a stub TelegramWidget holding `chatData`. Returns the root
// it draws into.
function runProgram(program: WidgetProgram, chatData: string, request: Request): FakeElement {
  const body = new FakeElement('body');
  const document = { body, createElement: (tag: string) => new FakeElement(tag) };
  const widget = {
    chatData,
    themeParams: {},
    request,
    onEvent: () => undefined,
    ready: () => undefined,
  };
  const html = WIDGET_PROGRAMS[program];
  const js = html.slice('<body><script>'.length, -'</script></body>'.length);
  runInNewContext(js, { window: { TelegramWidget: widget }, document });
  const root = body.children[1];
  if (root === undefined) throw new Error('the program drew no root');
  return root;
}

const rowsOf = (root: FakeElement) => root.children.filter((child) => child.className === 'l');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the donut program', () => {
  const fold = { name: 'Прочее', amount: (minor: number) => `${minor}` };
  // Ten lines: the donut keeps seven and folds three into «Прочее», whose token is ''.
  const lines: DonutLine[] = Array.from({ length: 10 }, (_, i) => [
    `Категория ${i + 1}`,
    (10 - i) * 1000,
    `${(10 - i) * 10}.00 RSD`,
    `${i + 1}`,
  ]);
  const chatData = encodeDonut(
    {
      title: 'Ноябрь 2026',
      total: '550.00 RSD',
      drill: '2026-11:00000000-0000-4000-8000-000000000001',
      lines,
      extra: '',
      retry: 'Не получилось загрузить. Нажмите ещё раз.',
    },
    fold,
  );
  if (chatData === undefined) throw new Error('setup: the donut does not fit');

  it('requests nothing on a tap of the fold line, and d:<drill>:<token> on another row', () => {
    const request = vi.fn<Request>(() => new Promise(() => undefined));
    const root = runProgram('donut', chatData, request);
    const rows = rowsOf(root);
    const foldRow = rows.at(-1);
    expect(foldRow?.text()).toContain('Прочее');
    expect(rows).toHaveLength(8);

    foldRow?.onclick?.({ target: null });
    // The fold line's slice, tapped on the donut.
    const donut = root.children[1];
    donut?.onclick?.({ target: { getAttribute: () => '7' } });
    expect(request).not.toHaveBeenCalled();

    rows[2]?.onclick?.({ target: null });
    expect(request.mock.calls).toEqual([['d:2026-11:00000000-0000-4000-8000-000000000001:3']]);
    // The tapped row waits with «…».
    expect(rowsOf(root)[2]?.text()).toContain('…');
  });

  it('turns into the answer bars, and [back] returns to the donut with no request', async () => {
    const answer = JSON.stringify([
      1,
      'Категория 3 · последние 6 месяцев',
      [
        ['Июнь', 0, '0.00 RSD'],
        ['Ноябрь', 8000, '80.00 RSD'],
      ],
      '‹ Все категории',
    ]);
    const request = vi.fn<Request>(() => Promise.resolve({ result: answer }));
    const root = runProgram('donut', chatData, request);

    rowsOf(root)[2]?.onclick?.({ target: null });
    await settle();

    expect(root.text()).toContain('Категория 3 · последние 6 месяцев');
    expect(rowsOf(root).map((row) => row.text())).toEqual(['Июнь 0.00 RSD', 'Ноябрь 80.00 RSD']);
    const back = root.children.at(-1);
    expect(back?.text()).toBe('‹ Все категории');
    back?.onclick?.({ target: null });
    expect(rowsOf(root)).toHaveLength(8);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shows an error answer text, or the retry text on a failed request, and stays tappable', async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce({ result: JSON.stringify([1, 'Эта категория больше недоступна.']) })
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
    const root = runProgram('donut', chatData, request);

    rowsOf(root)[0]?.onclick?.({ target: null });
    await settle();
    expect(root.children.at(-1)?.text()).toBe('Эта категория больше недоступна.');

    rowsOf(root)[0]?.onclick?.({ target: null });
    await settle();
    expect(root.children.at(-1)?.text()).toBe('Не получилось загрузить. Нажмите ещё раз.');
    expect(request).toHaveBeenCalledTimes(2);
    expect(rowsOf(root)[0]?.text()).not.toContain('…');
  });
});
