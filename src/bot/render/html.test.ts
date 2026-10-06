import type { Context } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../messages.js';
import { createTestBot, textUpdate } from '../testHarness.js';
import {
  TRANSIENT_MS,
  escapeHtml,
  html,
  htmlParseMode,
  joinHtml,
  sendTransient,
  type Html,
} from './html.js';

describe('html', () => {
  it('escapes every interpolated value and trusts the static parts', () => {
    expect(html`a ${'<b>&"'} b`).toBe('a &lt;b&gt;&amp;&quot; b');
    expect(html`<b>${'x'}</b>`).toBe('<b>x</b>');
    expect(html`${450} ${'>'}`).toBe('450 &gt;');
  });

  it('rejects interpolating Html, which would escape it twice', () => {
    const bold = html`<b>x</b>`;
    // @ts-expect-error Html parts are combined with joinHtml, never interpolated.
    const twice = html`${bold}`;
    expect(twice).toBe('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('joinHtml', () => {
  it('does not re-escape Html parts', () => {
    expect(joinHtml([html`${'&'}`, html`<b>x</b>`], '\n')).toBe('&amp;\n<b>x</b>');
  });

  it('escapes the separator', () => {
    expect(joinHtml([escapeHtml('a'), escapeHtml('b')], ' & ')).toBe('a &amp; b');
  });
});

describe('toasts and button labels', () => {
  it('stay plain strings, not Html', () => {
    const toast: string = messages.undoneToast;
    const label: string = messages.undoButton;
    // @ts-expect-error a toast is plain text; Telegram doesn't parse it.
    const htmlToast: Html = messages.undoneToast;
    // @ts-expect-error a button label is plain text.
    const htmlLabel: Html = messages.undoButton;
    // No markup to escape: the plain text is what the user sees.
    for (const text of [toast, label, htmlToast, htmlLabel]) {
      expect(text).not.toMatch(/[<>&]/);
    }
  });
});

describe('replyHtml', () => {
  it('sends with parse_mode HTML', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/today' }));

    expect(htmlParseMode).toEqual({ parse_mode: 'HTML' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({ parse_mode: 'HTML' });
  });
});

describe('sendTransient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A context whose reply is message 7 in chat 1001, recording what the API is asked.
  function fakeContext(deleteMessage: () => Promise<true>) {
    const calls: unknown[][] = [];
    const ctx = {
      reply: (...args: unknown[]) => {
        calls.push(['reply', ...args]);
        return Promise.resolve({ chat: { id: 1001 }, message_id: 7 });
      },
      api: {
        deleteMessage: (...args: unknown[]) => {
          calls.push(['deleteMessage', ...args]);
          return deleteMessage();
        },
      },
    } as unknown as Context;
    return { ctx, calls };
  }

  it('sends the reply and deletes it after 60 seconds, not before', async () => {
    const { ctx, calls } = fakeContext(() => Promise.resolve(true));
    const failed = vi.fn();

    await sendTransient(ctx, html`Не понял.`, failed);
    expect(calls).toEqual([['reply', 'Не понял.', htmlParseMode]]);

    await vi.advanceTimersByTimeAsync(TRANSIENT_MS - 1);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(TRANSIENT_MS).toBe(60_000);
    expect(calls).toEqual([
      ['reply', 'Не понял.', htmlParseMode],
      ['deleteMessage', 1001, 7],
    ]);
    expect(failed).not.toHaveBeenCalled();
  });

  it('hands a failed delete to the callback instead of throwing', async () => {
    const error = new Error('message to delete not found');
    const { ctx } = fakeContext(() => Promise.reject(error));
    const failed = vi.fn();

    await sendTransient(ctx, html`Не понял.`, failed);
    await vi.advanceTimersByTimeAsync(TRANSIENT_MS);

    expect(failed).toHaveBeenCalledWith(error);
  });
});
