import { Api } from 'grammy';
import { describe, expect, it } from 'vitest';
import { adminNotifier } from './adminNotifier.js';
import { html, htmlParseMode } from './render/html.js';

describe('adminNotifier', () => {
  it('sends the body to the admin chat it was given, as HTML', async () => {
    const api = new Api('123456:test-token');
    const calls: { method: string; payload: unknown }[] = [];
    api.config.use((_prev, method, payload) => {
      calls.push({ method, payload });
      // The fake answers every method alike; no code under test reads the result.
      return Promise.resolve({ ok: true, result: true as never });
    });
    const adminId = 424242;

    await adminNotifier(api, adminId)(html`<b>0.7.0</b>`);

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: adminId, text: '<b>0.7.0</b>', ...htmlParseMode },
      },
    ]);
    // Pinned as Telegram's own value, so a change to the shared constant cannot pass unseen.
    expect(calls[0]?.payload).toHaveProperty('parse_mode', 'HTML');
  });
});
