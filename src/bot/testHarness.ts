// Test-only: drives the real bot with updates and records Bot API calls instead of sending them.
import type { Update, UserFromGetMe } from 'grammy/types';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { createBot } from './bot.js';

export const ALLOWED_ID = 1001;
export const SECOND_ALLOWED_ID = 1003;
export const STRANGER_ID = 2002;

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

export interface ApiCall {
  method: string;
  payload: unknown;
}

export interface TestBotOptions {
  readonly now?: Date;
  readonly logLevel?: 'info' | 'silent';
}

export function createTestBot(options: TestBotOptions = {}) {
  const now = options.now ?? new Date('2026-09-29T22:10:00Z');
  const db: Db = openDatabase(':memory:');
  runMigrations(db, now);
  const logLines: string[] = [];
  let n = 0;
  const bot = createBot({
    token: '123456:test-token',
    allowedTelegramIds: new Set([ALLOWED_ID, SECOND_ALLOWED_ID]),
    logger: createLogger(options.logLevel ?? 'silent', {
      write: (line: string) => void logLines.push(line),
    }),
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => now,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    botInfo,
  });

  const calls: ApiCall[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    // The fake answers every method alike; no code under test reads the result.
    return Promise.resolve({ ok: true, result: true as never });
  });

  return { bot, db, calls, logLines };
}

// Log fields that can contain arbitrary digits unrelated to expense content.
const NOISE_FIELDS = new Set(['time', 'pid', 'hostname']);

export function logContent(line: string): string {
  const fields = Object.entries(JSON.parse(line) as Record<string, unknown>).filter(
    ([key]) => !NOISE_FIELDS.has(key),
  );
  return JSON.stringify(Object.fromEntries(fields));
}

export function textUpdate(opts: {
  updateId: number;
  text: string;
  fromId?: number;
  messageId?: number;
  date?: Date;
}): Update {
  const fromId = opts.fromId ?? ALLOWED_ID;
  const isCommand = opts.text.startsWith('/');
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId ?? 1,
      date: Math.floor((opts.date ?? new Date('2026-09-29T21:50:00Z')).getTime() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      text: opts.text,
      ...(isCommand
        ? {
            entities: [
              { type: 'bot_command', offset: 0, length: opts.text.split(' ')[0]?.length ?? 0 },
            ],
          }
        : {}),
    },
  };
}

export function callbackUpdate(opts: {
  updateId: number;
  data: string;
  fromId?: number;
  messageId?: number;
}): Update {
  const fromId = opts.fromId ?? ALLOWED_ID;
  return {
    update_id: opts.updateId,
    callback_query: {
      id: `cb-${opts.updateId}`,
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      chat_instance: 'test',
      data: opts.data,
      message: {
        message_id: opts.messageId ?? 2,
        date: 1_790_000_000,
        chat: { id: fromId, type: 'private', first_name: 'Test' },
        text: 'confirmation',
      },
    },
  };
}
