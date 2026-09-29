import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logger.js';
import { createBot } from '../bot.js';
import { messages } from '../messages.js';

const ALLOWED_ID = 1001;
const STRANGER_ID = 2002;

const botInfo: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'Test Bot',
  username: 'test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface ApiCall {
  method: string;
  payload: unknown;
}

// Replaces the network: every Bot API call is recorded and answered with `true`.
function recordApiCalls(bot: Bot): ApiCall[] {
  const calls: ApiCall[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    // The fake answers every method alike; no code under test reads the result.
    return Promise.resolve({ ok: true, result: true as never });
  });
  return calls;
}

function commandUpdate(updateId: number, fromId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 1_790_000_000,
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  };
}

function setup() {
  const bot = createBot({
    token: '123456:test-token',
    allowedTelegramIds: new Set([ALLOWED_ID]),
    logger: createLogger('silent'),
    botInfo,
  });
  const calls = recordApiCalls(bot);
  return { bot, calls };
}

describe('allowlist', () => {
  it('stops an update from a non-allowlisted sender before any handler', async () => {
    const { bot, calls } = setup();
    const spy = vi.fn();
    bot.use(spy);

    await bot.handleUpdate(commandUpdate(1, STRANGER_ID, '/start'));

    expect(spy).toHaveBeenCalledTimes(0);
    expect(calls).toEqual([]);
  });

  it('lets an allowlisted sender through to handlers', async () => {
    const { bot } = setup();
    const spy = vi.fn();
    bot.use(spy);

    await bot.handleUpdate(commandUpdate(1, ALLOWED_ID, '/help'));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('answers an allowlisted /start with the messages-module greeting', async () => {
    const { bot, calls } = setup();

    await bot.handleUpdate(commandUpdate(1, ALLOWED_ID, '/start'));

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.welcome } },
    ]);
  });
});
