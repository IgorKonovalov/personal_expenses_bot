import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../messages.js';
import { ALLOWED_ID, STRANGER_ID, createTestBot, textUpdate } from '../testHarness.js';

// A non-text message: past the allowlist it gets the help reply.
function locationUpdate(updateId: number, fromId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 1_790_000_000,
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      location: { latitude: 0, longitude: 0 },
    },
  };
}

describe('allowlist', () => {
  it('stops an update from a non-allowlisted sender before any handler', async () => {
    const { bot, calls, db } = createTestBot();
    const spy = vi.fn();
    bot.use(spy);

    await bot.handleUpdate(locationUpdate(1, STRANGER_ID));
    await bot.handleUpdate(textUpdate({ updateId: 2, fromId: STRANGER_ID, text: '/start' }));
    await bot.handleUpdate(textUpdate({ updateId: 3, fromId: STRANGER_ID, text: '450 coffee' }));

    expect(spy).toHaveBeenCalledTimes(0);
    expect(calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  it('lets an allowlisted sender through to handlers', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(locationUpdate(1, ALLOWED_ID));

    expect(calls).toMatchObject([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.help } },
    ]);
  });

  it('answers an allowlisted /start with the messages-module greeting', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start' }));

    expect(calls).toMatchObject([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.welcome } },
    ]);
  });
});
