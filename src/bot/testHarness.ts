// Test-only: drives the real bot with updates and records Bot API calls instead of sending them.
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { admitTelegramIds, type AdmissionDeps } from '../services/admission.js';
import { createLedgerKeyring } from '../services/ledgerKeys.js';
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
  // Bot API methods the fake rejects with a 400, e.g. a chat with reactions disabled.
  readonly failMethods?: readonly string[];
}

export function createTestBot(options: TestBotOptions = {}) {
  const now = options.now ?? new Date('2026-09-29T22:10:00Z');
  const db: Db = openDatabase(':memory:');
  runMigrations(db, now);
  const logLines: string[] = [];
  let n = 0;
  const keys = createLedgerKeyring(() => now);
  const deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => now,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    adminTelegramId: ALLOWED_ID,
  } as const;
  const bot = createBot({
    ...deps,
    token: '123456:test-token',
    logger: createLogger(options.logLevel ?? 'silent', {
      write: (line: string) => void logLines.push(line),
    }),
    keys,
    botInfo,
  });
  admitOnFirstDm(bot, deps, [SECOND_ALLOWED_ID]);

  const calls: ApiCall[] = [];
  const failing = new Set(options.failMethods ?? []);
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    if (failing.has(method)) {
      return Promise.resolve({ ok: false, error_code: 400, description: 'Bad Request: test' });
    }
    // The fake answers every method alike; no code under test reads the result.
    return Promise.resolve({ ok: true, result: true as never });
  });

  return { bot, db, calls, logLines, keys };
}

// Admits each of `ids` the way a redeemed invite would, just before that id's first private
// update is handled. The handler would provision the user on that update anyway, so ids and
// timestamps come out as they would for a user who joined a moment earlier. The admin
// (ALLOWED_ID) needs nothing: it is always admitted.
export function admitOnFirstDm(
  bot: Bot,
  deps: AdmissionDeps & { readonly now: () => Date },
  ids: readonly number[],
): void {
  const handle = bot.handleUpdate.bind(bot);
  bot.handleUpdate = async (update, envelope) => {
    const from = update.message?.from ?? update.edited_message?.from ?? update.callback_query?.from;
    const chat =
      update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat;
    if (from !== undefined && chat?.type === 'private' && ids.includes(from.id)) {
      admitTelegramIds(deps, [from.id], deps.now());
    }
    await handle(update, envelope);
  };
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

export const GROUP_ID = -100500;
export const GROUP_TITLE = 'Семья';

function commandEntities(text: string) {
  return text.startsWith('/')
    ? {
        entities: [
          { type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]?.length ?? 0 },
        ],
      }
    : {};
}

// A message in a supergroup. `content` is the message's own fields: `{ text }`, `{ sticker }`…
export function groupMessageUpdate(opts: {
  updateId: number;
  content: Record<string, unknown>;
  fromId?: number;
  firstName?: string;
  isBot?: boolean;
  chatId?: number;
  messageId?: number;
  date?: Date;
  senderChat?: { id: number; type: 'channel' | 'supergroup'; title: string };
  replyTo?: number;
}): Update {
  const fromId = opts.fromId ?? ALLOWED_ID;
  const chatId = opts.chatId ?? GROUP_ID;
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId ?? 1,
      date: Math.floor((opts.date ?? new Date('2026-09-29T21:50:00Z')).getTime() / 1000),
      chat: { id: chatId, type: 'supergroup', title: GROUP_TITLE },
      from: { id: fromId, is_bot: opts.isBot ?? false, first_name: opts.firstName ?? 'Test' },
      ...(opts.senderChat === undefined ? {} : { sender_chat: opts.senderChat }),
      ...(opts.replyTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: opts.replyTo,
              date: 0,
              chat: { id: chatId, type: 'supergroup', title: GROUP_TITLE },
            },
          }),
      ...opts.content,
    } as Update['message'],
  } as Update;
}

export function groupTextUpdate(opts: {
  updateId: number;
  text: string;
  fromId?: number;
  firstName?: string;
  isBot?: boolean;
  chatId?: number;
  messageId?: number;
  date?: Date;
  senderChat?: { id: number; type: 'channel' | 'supergroup'; title: string };
  replyTo?: number;
}): Update {
  const { text, ...rest } = opts;
  return groupMessageUpdate({ ...rest, content: { text, ...commandEntities(text) } });
}

// The bot's own membership in a group changing, done by `fromId`.
export function myChatMemberUpdate(opts: {
  updateId: number;
  fromId: number;
  oldStatus: 'left' | 'kicked' | 'member' | 'administrator';
  newStatus: 'left' | 'kicked' | 'member' | 'administrator';
  chatId?: number;
  title?: string;
}): Update {
  const bot = { id: botInfo.id, is_bot: true, first_name: botInfo.first_name };
  const member = (status: string) =>
    status === 'kicked' ? { status, user: bot, until_date: 0 } : { status, user: bot };
  return {
    update_id: opts.updateId,
    my_chat_member: {
      chat: { id: opts.chatId ?? GROUP_ID, type: 'supergroup', title: opts.title ?? GROUP_TITLE },
      from: { id: opts.fromId, is_bot: false, first_name: 'Test' },
      date: 1_790_000_000,
      old_chat_member: member(opts.oldStatus),
      new_chat_member: member(opts.newStatus),
    },
  } as Update;
}

export function callbackUpdate(opts: {
  updateId: number;
  data: string;
  fromId?: number;
  messageId?: number;
  // A group's id puts the tapped message in that supergroup; the sender's DM otherwise.
  chatId?: number;
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
        chat:
          opts.chatId === undefined
            ? { id: fromId, type: 'private', first_name: 'Test' }
            : { id: opts.chatId, type: 'supergroup', title: GROUP_TITLE },
        text: 'confirmation',
      },
    },
  };
}
