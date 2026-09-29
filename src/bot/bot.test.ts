import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { createBot } from './bot.js';
import { messages } from './messages.js';

const USER_ID = 1001;

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

function textUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 7,
      date: 1_790_000_000,
      chat: { id: USER_ID, type: 'private', first_name: 'Test' },
      from: { id: USER_ID, is_bot: false, first_name: 'Test' },
      text,
    },
  };
}

describe('error boundary', () => {
  it('replies with one generic apology and logs the update id without the message text', async () => {
    const lines: string[] = [];
    const bot = createBot({
      token: '123456:test-token',
      allowedTelegramIds: new Set([USER_ID]),
      logger: createLogger('info', { write: (line: string) => void lines.push(line) }),
      botInfo,
    });
    const calls = recordApiCalls(bot);
    bot.on('message:text', () => {
      throw new Error('handler exploded');
    });

    await bot.handleUpdate(textUpdate(555, '450 synthetic-coffee'));

    expect(calls).toEqual([
      { method: 'sendMessage', payload: { chat_id: USER_ID, text: messages.genericError } },
    ]);
    const errorLines = lines.filter((line) => line.includes('handler failed'));
    expect(errorLines).toHaveLength(1);
    const [errorLine] = errorLines;
    expect(JSON.parse(errorLine ?? '{}')).toMatchObject({ updateId: 555, level: 50 });
    for (const line of lines) {
      expect(line).not.toContain('synthetic-coffee');
      expect(line).not.toContain('450');
    }
  });
});
