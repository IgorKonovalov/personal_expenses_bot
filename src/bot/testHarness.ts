// Test-only: drives the real bot with updates and records Bot API calls instead of sending them.
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { admitTelegramIds, type AdmissionDeps } from '../services/admission.js';
import { createLedgerKeyring } from '../services/ledgerKeys.js';
import { adminNotifier } from './adminNotifier.js';
import { createJobQueue, type JobRunner } from '../jobs/queue.js';
import { createBot, inProcessRunner } from './bot.js';
import { createDonationLinks, type DonationLinks } from './handlers/donate.js';

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
  // DONATE_URL.
  readonly donateUrl?: string;
  // WEBAPP_URL.
  readonly webappUrl?: string;
  // First contact and tips (ADR-0028), both off unless a test is about them.
  readonly onboarding?: boolean;
  readonly tips?: boolean;
  // The heavy-job queue (ADR-0042): how a job runs (default: in this process, downloading
  // through `fetch`), its time limit, and whether handleUpdate waits for the queue to drain
  // before it resolves (default: it does, so a photo's reply is in `calls` once it returns).
  readonly jobRunner?: JobRunner;
  readonly jobTimeoutMs?: number;
  readonly drainJobs?: boolean;
}

// The admin, as in production: the first allowed id (ADR-0013).
export const ADMIN_ID = 1001;

export function createTestBot(options: TestBotOptions = {}) {
  const now = options.now ?? new Date('2026-09-29T22:10:00Z');
  const db: Db = openDatabase(':memory:');
  runMigrations(db, now);
  quietFirstContact(db, options);
  const logLines: string[] = [];
  let n = 0;
  const keys = createLedgerKeyring(() => now);
  const logger = createLogger(options.logLevel ?? 'silent', {
    write: (line: string) => void logLines.push(line),
  });
  const donationLinks: DonationLinks = new Map();
  const deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    now: () => now,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    adminTelegramId: ADMIN_ID,
  } as const;
  const token = '123456:test-token';
  const jobs = createJobQueue({
    run: options.jobRunner ?? inProcessRunner(token),
    onError: (error) => {
      logger.error({ err: error instanceof Error ? error.name : typeof error }, 'job failed');
    },
    ...(options.jobTimeoutMs === undefined ? {} : { timeoutMs: options.jobTimeoutMs }),
  });
  const bot = createBot({
    ...deps,
    token,
    backupKeep: 14,
    logger,
    keys,
    botInfo,
    donationLinks,
    donateUrl: options.donateUrl,
    webappUrl: options.webappUrl,
    notifyAdmin: (body) => adminNotifier(bot.api, ADMIN_ID)(body),
    jobs,
  });
  admitOnFirstDm(bot, deps, [SECOND_ALLOWED_ID]);
  if (options.drainJobs ?? true) {
    const handle = bot.handleUpdate.bind(bot);
    bot.handleUpdate = async (update, envelope) => {
      await handle(update, envelope);
      await jobs.idle();
    };
  }

  const calls: ApiCall[] = [];
  const failing = new Set(options.failMethods ?? []);
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    if (failing.has(method)) {
      return Promise.resolve({ ok: false, error_code: 400, description: 'Bad Request: test' });
    }
    // An invoice link names its payload, so a test can tell the buttons apart.
    if (method === 'createInvoiceLink') {
      const { payload: invoicePayload } = payload as { payload: string };
      return Promise.resolve({ ok: true, result: invoiceLink(invoicePayload) as never });
    }
    // Every other method is answered alike; no code under test reads the result.
    return Promise.resolve({ ok: true, result: true as never });
  });

  // What index.ts does at boot, after createBot. Records the createInvoiceLink calls.
  const prepareDonations = () => createDonationLinks(bot.api, logger, donationLinks);

  return { bot, db, calls, logLines, keys, prepareDonations, jobsIdle: () => jobs.idle() };
}

// Keeps first contact and tips (ADR-0028) out of the replies of a test that isn't about them.
// Unless `onboarding`, every user is onboarded the moment it is created, so its first message gets
// only its own reply. Unless `tips`, every user's tips are off and stay off, the /start replay
// included. Also for a bot a test builds with createBot itself.
export function quietFirstContact(
  db: Db,
  { onboarding = false, tips = false }: { onboarding?: boolean; tips?: boolean } = {},
): void {
  if (!onboarding) {
    db.exec(`CREATE TEMP TRIGGER test_onboarded AFTER INSERT ON users BEGIN
               UPDATE users SET onboarded_at = NEW.created_at WHERE id = NEW.id;
             END`);
  }
  if (!tips) {
    db.exec(`CREATE TEMP TRIGGER test_tips_off AFTER INSERT ON users BEGIN
               UPDATE users SET tips_off = 1 WHERE id = NEW.id;
             END;
             CREATE TEMP TRIGGER test_tips_stay_off AFTER UPDATE OF tips_off ON users
               WHEN NEW.tips_off = 0 BEGIN
               UPDATE users SET tips_off = 1 WHERE id = NEW.id;
             END`);
  }
}

// Gives every sendMessage a result with a fresh message id, so a screen can become the anchor.
// Returns the last id handed out.
export function withMessageIds(bot: Bot, first = 100): () => number {
  let messageId = first;
  bot.api.config.use(async (prev, method, payload, signal) => {
    const answer = await prev(method, payload, signal);
    if (method !== 'sendMessage') return answer;
    const chat = { id: (payload as { chat_id: number }).chat_id, type: 'private' };
    return { ok: true, result: { message_id: ++messageId, date: 0, chat, text: '' } as never };
  });
  return () => messageId;
}

// The fake's invoice link for a payload, e.g. `donate:150`.
export function invoiceLink(payload: string): string {
  return `https://t.me/$test-${payload.replace(':', '-')}`;
}

export function preCheckoutUpdate(opts: {
  updateId: number;
  currency: string;
  totalAmount: number;
  payload: string;
  fromId?: number;
}): Update {
  return {
    update_id: opts.updateId,
    pre_checkout_query: {
      id: `pcq-${opts.updateId}`,
      from: { id: opts.fromId ?? ALLOWED_ID, is_bot: false, first_name: 'Test' },
      currency: opts.currency,
      total_amount: opts.totalAmount,
      invoice_payload: opts.payload,
    },
  };
}

export function successfulPaymentUpdate(opts: {
  updateId: number;
  stars: number;
  chargeId: string;
  fromId?: number;
}): Update {
  const fromId = opts.fromId ?? ALLOWED_ID;
  return {
    update_id: opts.updateId,
    message: {
      message_id: 100 + opts.updateId,
      date: 1_790_000_000,
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      successful_payment: {
        currency: 'XTR',
        total_amount: opts.stars,
        invoice_payload: `donate:${opts.stars}`,
        telegram_payment_charge_id: opts.chargeId,
        provider_payment_charge_id: '',
      },
    },
  };
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

// A file sent in the sender's DM. The harness answers no getFile: a test that downloads adds its
// own.
export function documentUpdate(opts: {
  updateId: number;
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize: number;
  fromId?: number;
  date?: Date;
}): Update {
  const fromId = opts.fromId ?? ALLOWED_ID;
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.updateId,
      date: Math.floor((opts.date ?? new Date('2026-09-29T21:50:00Z')).getTime() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      document: {
        file_id: opts.fileId,
        file_unique_id: opts.fileId,
        file_name: opts.fileName,
        ...(opts.mimeType === undefined ? {} : { mime_type: opts.mimeType }),
        file_size: opts.fileSize,
      },
    },
  };
}

// A synthetic Telegram Desktop chat export (ADR-0047), as `result.json` holds it: a message's
// `from` is null for a deleted account.
export interface ExportMessageFixture {
  readonly id: number;
  readonly at: Date;
  readonly fromId: number;
  readonly from: string | null;
  readonly text: string;
  readonly forwarded?: boolean;
}

export function chatExportJson(opts: {
  id: number;
  type?: string;
  name?: string;
  messages: readonly ExportMessageFixture[];
}): string {
  return JSON.stringify({
    name: opts.name ?? GROUP_TITLE,
    type: opts.type ?? 'private_supergroup',
    id: opts.id,
    messages: opts.messages.map((message) => ({
      id: message.id,
      type: 'message',
      date: message.at.toISOString().slice(0, 19),
      date_unixtime: String(Math.floor(message.at.getTime() / 1000)),
      from: message.from,
      from_id: `user${message.fromId}`,
      text: message.text,
      ...(message.forwarded === true ? { forwarded_from: 'Кто-то' } : {}),
    })),
  });
}

// The service message a Mini App's sendData produces in the sender's DM.
export function webAppDataUpdate(opts: {
  updateId: number;
  data: string;
  fromId?: number;
  messageId?: number;
  date?: Date;
}): Update {
  const fromId = opts.fromId ?? ALLOWED_ID;
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId ?? 1,
      date: Math.floor((opts.date ?? new Date('2026-09-29T21:50:00Z')).getTime() / 1000),
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      web_app_data: { data: opts.data, button_text: '📷 Скан' },
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
