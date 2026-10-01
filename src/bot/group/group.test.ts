import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { CategoryId } from '../../db/categories.js';
import type { Db } from '../../db/connection.js';
import type { ExpenseId } from '../../db/expenses.js';
import { findUserByIdentity, type User } from '../../db/users.js';
import { monthOf } from '../../domain/periods.js';
import type { LocalDate } from '../../domain/time.js';
import { createLogger } from '../../logger.js';
import { changeCategory } from '../../services/changeCategory.js';
import { openEdit, startEdit } from '../../services/editExpense.js';
import { undoExpense } from '../../services/recordExpense.js';
import { assertCallbackData, groupDeleteData, groupRestoreData } from '../callbackData.js';
import { messages } from '../messages.js';
import { htmlParseMode } from '../render/html.js';
import {
  ALLOWED_ID,
  GROUP_ID,
  SECOND_ALLOWED_ID,
  STRANGER_ID,
  callbackUpdate,
  createTestBot,
  groupMessageUpdate,
  groupTextUpdate,
  myChatMemberUpdate,
  textUpdate,
} from '../testHarness.js';

// A = ALLOWED_ID (Belgrade, personal ledger in RSD), B = STRANGER_ID (never DMed the bot),
// group -100500 titled «Семья». Invented names only.
const THIRD_ID = 3003;
// Wednesday 30 September, 12:00 in Belgrade.
const NOW = new Date('2026-09-30T10:00:00Z');

interface HarnessOptions {
  readonly failMethods?: readonly string[];
  readonly now?: Date;
}

function harness(options: HarnessOptions = {}) {
  const test = createTestBot({ now: NOW, ...options });
  let updateId = 0;
  const send = (update: (id: number) => Update) => test.bot.handleUpdate(update(++updateId));
  const added = (fromId: number, chatId = GROUP_ID) =>
    send((id) =>
      myChatMemberUpdate({ updateId: id, fromId, chatId, oldStatus: 'left', newStatus: 'member' }),
    );
  const say = (
    fromId: number,
    text: string,
    messageId: number,
    opts: { date?: Date; firstName?: string; chatId?: number } = {},
  ) =>
    send((id) =>
      groupTextUpdate({ updateId: id, text, fromId, messageId, date: opts.date ?? NOW, ...opts }),
    );
  const dm = (fromId: number, text: string, messageId: number, date = NOW) =>
    send((id) => textUpdate({ updateId: id, text, fromId, messageId, date }));
  const tap = (fromId: number, data: string, opts: { chatId?: number; messageId?: number } = {}) =>
    send((id) => callbackUpdate({ updateId: id, data, fromId, ...opts }));
  return { ...test, send, added, say, dm, tap };
}

// The harness with the group bound by A, and the calls so far cleared.
async function bound(options: HarnessOptions = {}) {
  const test = harness(options);
  await test.added(ALLOWED_ID);
  test.calls.length = 0;
  return test;
}

function userOf(db: Db, telegramId: number) {
  return db
    .prepare(
      `SELECT u.id, u.timezone, u.active_ledger_id AS activeLedgerId
         FROM users u JOIN auth_identities i ON i.user_id = u.id
        WHERE i.provider = 'telegram' AND i.external_id = ?`,
    )
    .get(String(telegramId)) as
    { id: string; timezone: string; activeLedgerId: string } | undefined;
}

function groupLedgerId(db: Db): string {
  return db.prepare('SELECT ledger_id FROM ledger_chats').pluck().get() as string;
}

function expensesIn(db: Db, ledgerId: string) {
  return db
    .prepare(
      `SELECT created_by, amount_minor, currency, description, occurred_on, source_key
         FROM expenses WHERE ledger_id = ? ORDER BY rowid`,
    )
    .all(ledgerId);
}

describe('binding a group (Phase 1)', () => {
  it('binds the group to a new shared ledger when A adds the bot, and welcomes once', async () => {
    const { db, calls, added } = harness();

    await added(ALLOWED_ID);

    const a = userOf(db, ALLOWED_ID);
    expect(
      db
        .prepare(
          "SELECT id, name, default_currency, timezone, owner_user_id FROM ledgers WHERE kind = 'shared'",
        )
        .all(),
    ).toEqual([
      {
        id: groupLedgerId(db),
        name: 'Семья',
        default_currency: 'RSD',
        timezone: 'Europe/Belgrade',
        owner_user_id: a?.id,
      },
    ]);
    expect(
      db
        .prepare('SELECT user_id, role FROM ledger_members WHERE ledger_id = ?')
        .all(groupLedgerId(db)),
    ).toEqual([{ user_id: a?.id, role: 'owner' }]);
    expect(db.prepare('SELECT chat_id, active FROM ledger_chats').all()).toEqual([
      { chat_id: String(GROUP_ID), active: 1 },
    ]);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: GROUP_ID,
          text: messages.groupWelcome({ timezone: 'Europe/Belgrade', currency: 'RSD' }),
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('leaves the group when B adds the bot, creating no ledger and no binding', async () => {
    const { db, calls, added } = harness();

    await added(STRANGER_ID);

    expect(calls).toEqual([{ method: 'leaveChat', payload: { chat_id: GROUP_ID } }]);
    expect(db.prepare("SELECT COUNT(*) FROM ledgers WHERE kind = 'shared'").pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_chats').pluck().get()).toBe(0);
  });
});

describe('recording in a bound group (Phase 1)', () => {
  it("provisions B on their first expense and records it in the group ledger as B's", async () => {
    const { db, say } = await bound();

    await say(STRANGER_ID, '300 такси', 11);

    const b = userOf(db, STRANGER_ID);
    expect(b?.timezone).toBe('Europe/Belgrade');
    expect(
      db.prepare('SELECT kind, owner_user_id FROM ledgers WHERE id = ?').get(b?.activeLedgerId),
    ).toEqual({ kind: 'personal', owner_user_id: b?.id });
    expect(
      db
        .prepare('SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?')
        .pluck()
        .get(groupLedgerId(db), b?.id),
    ).toBe('member');
    expect(expensesIn(db, groupLedgerId(db))).toEqual([
      {
        created_by: b?.id,
        amount_minor: 30000,
        currency: 'RSD',
        description: 'такси',
        occurred_on: '2026-09-30',
        source_key: `tg:${GROUP_ID}:11`,
      },
    ]);
  });

  it("records A's group expense in the group ledger only: the active ledger and DM /today stay personal", async () => {
    const { db, calls, say, dm } = await bound();
    const before = userOf(db, ALLOWED_ID);

    await say(ALLOWED_ID, '450 кафе', 12);
    await dm(ALLOWED_ID, '/today', 13);

    expect(expensesIn(db, groupLedgerId(db))).toMatchObject([
      { created_by: before?.id, amount_minor: 45000, currency: 'RSD', description: 'кафе' },
    ]);
    expect(userOf(db, ALLOWED_ID)?.activeLedgerId).toBe(before?.activeLedgerId);
    expect(calls.at(-1)).toEqual({
      method: 'sendMessage',
      payload: {
        chat_id: ALLOWED_ID,
        text: messages.today({
          ledger: { kind: 'personal', name: 'Personal' },
          date: '2026-09-30' as never,
          totals: new Map(),
        }),
        ...htmlParseMode,
      },
    });
  });

  it("dates a group expense in the ledger's timezone and a DM one in the sender's", async () => {
    const { db, say, dm } = await bound();
    await dm(SECOND_ALLOWED_ID, '/start', 1);
    db.prepare("UPDATE users SET timezone = 'America/New_York'").run();
    const late = new Date('2026-09-30T23:30:00Z');

    await say(SECOND_ALLOWED_ID, '500 такси', 14, { date: late });
    await dm(SECOND_ALLOWED_ID, '500 такси', 15, late);

    const second = userOf(db, SECOND_ALLOWED_ID);
    // Belgrade (CEST, UTC+2): 01:30 on 1 October.
    expect(expensesIn(db, groupLedgerId(db))).toMatchObject([{ occurred_on: '2026-10-01' }]);
    // New York (EDT, UTC-4): 19:30 on 30 September.
    expect(expensesIn(db, second?.activeLedgerId ?? '')).toMatchObject([
      { occurred_on: '2026-09-30' },
    ]);
  });

  it("leaves A's pending DM flow untouched by A's group expense and group /month", async () => {
    const { db, say, dm, tap } = await bound();
    await dm(ALLOWED_ID, '450 кофе', 20);
    const expenseId = db.prepare('SELECT id FROM expenses').pluck().get() as string;
    await tap(ALLOWED_ID, `exp:edit:${expenseId}`);
    await tap(ALLOWED_ID, `exp:ef:${expenseId}:a`);
    const a = userOf(db, ALLOWED_ID);
    const session = () => db.prepare('SELECT * FROM flow_sessions WHERE user_id = ?').get(a?.id);
    const pending = session();
    expect(pending).toMatchObject({ kind: 'editAmount', anchor_message_id: 2 });

    await say(ALLOWED_ID, '450 кафе', 21);
    expect(expensesIn(db, groupLedgerId(db))).toMatchObject([{ amount_minor: 45000 }]);
    expect(session()).toEqual(pending);

    await say(ALLOWED_ID, '/month', 22);
    expect(session()).toEqual(pending);
  });

  it('answers no chatter, sticker, photo or other bot command, and stores no chatter sender', async () => {
    const { db, calls, say, send } = await bound();

    await say(THIRD_ID, 'привет всем', 30);
    await send((id) =>
      groupMessageUpdate({
        updateId: id,
        fromId: ALLOWED_ID,
        messageId: 31,
        content: {
          sticker: {
            file_id: 's',
            file_unique_id: 's',
            type: 'regular',
            width: 1,
            height: 1,
            is_animated: false,
            is_video: false,
          },
        },
      }),
    );
    await send((id) =>
      groupMessageUpdate({
        updateId: id,
        fromId: ALLOWED_ID,
        messageId: 32,
        content: { photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] },
      }),
    );
    await say(ALLOWED_ID, '/start@other_bot', 33);

    expect(calls).toEqual([]);
    expect(userOf(db, THIRD_ID)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(0);
  });

  it('answers nothing and creates no user in a group nobody bound', async () => {
    const { db, calls, say } = harness();

    await say(STRANGER_ID, '300 такси', 40);
    await say(ALLOWED_ID, '450 кафе', 41, { chatId: -100777 });

    expect(calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0);
  });

  it("records a redelivered update of B's expense once", async () => {
    const { bot, db } = await bound();
    const update = groupTextUpdate({
      updateId: 50,
      text: '300 такси',
      fromId: STRANGER_ID,
      messageId: 51,
      date: NOW,
    });

    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    expect(db.prepare('SELECT source_key FROM expenses').pluck().all()).toEqual([
      `tg:${GROUP_ID}:51`,
    ]);
  });

  it('answers and records nothing for messages on behalf of a chat or from a bot', async () => {
    const { db, calls, send } = await bound();

    await send((id) =>
      groupTextUpdate({
        updateId: id,
        text: '300 такси',
        fromId: 1087968824,
        isBot: true,
        messageId: 60,
        date: NOW,
        senderChat: { id: GROUP_ID, type: 'supergroup', title: 'Семья' },
      }),
    );
    await send((id) =>
      groupTextUpdate({
        updateId: id,
        text: '300 такси',
        fromId: 777000,
        messageId: 61,
        date: NOW,
        senderChat: { id: -100321, type: 'channel', title: 'Канал' },
      }),
    );
    await send((id) =>
      groupTextUpdate({
        updateId: id,
        text: '300 такси',
        fromId: 9010,
        isBot: true,
        messageId: 62,
        date: NOW,
      }),
    );

    expect(calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(0);
  });
});

function expenseIdOf(db: Db, messageId: number): ExpenseId {
  return db
    .prepare('SELECT id FROM expenses WHERE source_key = ?')
    .pluck()
    .get(`tg:${GROUP_ID}:${messageId}`) as ExpenseId;
}

function deletedAtOf(db: Db, expenseId: ExpenseId): unknown {
  return db.prepare('SELECT deleted_at FROM expenses WHERE id = ?').pluck().get(expenseId);
}

const TODAY = '2026-09-30' as LocalDate;

// B's `2 минуты буду` as the group card shows it.
function minutesCard(author: string, amountMinor: number, description: string) {
  return messages.groupExpenseCard({
    author,
    expense: {
      amountMinor,
      currency: 'RSD',
      description,
      category: { name: 'Другое' },
      occurredOn: TODAY,
    },
    sentOn: TODAY,
  });
}

describe('quiet confirmation and the group card (Phase 2)', () => {
  it("reacts to A's recognised expense and sends no message", async () => {
    const { calls, say } = await bound();

    await say(ALLOWED_ID, '450 кафе', 12, { firstName: 'Анна' });

    expect(calls).toEqual([
      {
        method: 'setMessageReaction',
        payload: {
          chat_id: GROUP_ID,
          message_id: 12,
          reaction: [{ type: 'emoji', emoji: messages.groupRecordedReaction }],
        },
      },
    ]);
  });

  it('replies a card with [Удалить] only to B, who is not allowlisted, and adds the DM link for A', async () => {
    const { db, calls, say } = await bound();

    await say(STRANGER_ID, '2 минуты буду', 13, { firstName: 'Борис' });
    await say(ALLOWED_ID, '5 минут буду', 14, { firstName: 'Анна' });

    const b = expenseIdOf(db, 13);
    const a = expenseIdOf(db, 14);
    expect(
      db
        .prepare(
          `SELECT e.amount_minor, e.currency, c.name FROM expenses e
             JOIN categories c ON c.id = e.category_id WHERE e.id = ?`,
        )
        .get(b),
    ).toEqual({ amount_minor: 200, currency: 'RSD', name: 'Другое' });
    expect(minutesCard('Борис', 200, 'минуты буду')).toContain('2.00 RSD');
    expect(minutesCard('Борис', 200, 'минуты буду')).toContain('Борис');
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: GROUP_ID,
          text: minutesCard('Борис', 200, 'минуты буду'),
          reply_parameters: { message_id: 13 },
          reply_markup: {
            inline_keyboard: [[{ text: messages.undoButton, callback_data: `grp:del:${b}` }]],
          },
          ...htmlParseMode,
        },
      },
      {
        method: 'sendMessage',
        payload: {
          chat_id: GROUP_ID,
          text: minutesCard('Анна', 500, 'минут буду'),
          reply_parameters: { message_id: 14 },
          reply_markup: {
            inline_keyboard: [
              [
                { text: messages.undoButton, callback_data: `grp:del:${a}` },
                {
                  text: messages.groupEditInDmButton,
                  url: `https://t.me/test_bot?start=e_${a}`,
                },
              ],
            ],
          },
          ...htmlParseMode,
        },
      },
    ]);
    // Telegram allows a start payload of 64 bytes.
    expect(Buffer.byteLength(`e_${a}`, 'utf8')).toBe(38);
  });

  it('sends the card when the chat refuses the reaction, and records once', async () => {
    const { db, calls, say } = await bound({ failMethods: ['setMessageReaction'] });

    await say(ALLOWED_ID, '450 кафе', 12, { firstName: 'Анна' });

    expect(calls.map((call) => call.method)).toEqual(['setMessageReaction', 'sendMessage']);
    expect(calls[1]?.payload).toMatchObject({
      chat_id: GROUP_ID,
      reply_parameters: { message_id: 12 },
    });
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
  });

  it("lets only B delete B's expense from the card, once", async () => {
    const { db, calls, say, tap } = await bound();
    await say(STRANGER_ID, '2 минуты буду', 13, { firstName: 'Борис' });
    const id = expenseIdOf(db, 13);
    calls.length = 0;

    await tap(ALLOWED_ID, groupDeleteData(id), { chatId: GROUP_ID, messageId: 70 });
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: {
          callback_query_id: expect.any(String) as unknown,
          text: messages.groupNotAuthor,
        },
      },
    ]);
    expect(deletedAtOf(db, id)).toBeNull();

    calls.length = 0;
    await tap(STRANGER_ID, groupDeleteData(id), { chatId: GROUP_ID, messageId: 70 });
    const deletedAt = deletedAtOf(db, id);
    expect(deletedAt).toBe(NOW.toISOString());
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) as unknown, text: messages.undoneToast },
      },
      {
        method: 'editMessageText',
        payload: {
          chat_id: GROUP_ID,
          message_id: 70,
          text: messages.groupExpenseDeleted({
            author: 'Test',
            expense: {
              amountMinor: 200,
              currency: 'RSD',
              description: 'минуты буду',
              category: { name: 'Другое' },
              occurredOn: TODAY,
            },
            sentOn: TODAY,
          }),
          reply_markup: {
            inline_keyboard: [[{ text: messages.restoreButton, callback_data: `grp:res:${id}` }]],
          },
          ...htmlParseMode,
        },
      },
    ]);

    calls.length = 0;
    await tap(STRANGER_ID, groupDeleteData(id), { chatId: GROUP_ID, messageId: 70 });
    expect(deletedAtOf(db, id)).toBe(deletedAt);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) as unknown, text: messages.alreadyUndone },
      },
    ]);

    calls.length = 0;
    await tap(ALLOWED_ID, groupRestoreData(id), { chatId: GROUP_ID, messageId: 70 });
    expect(deletedAtOf(db, id)).toBe(deletedAt);
    await tap(STRANGER_ID, groupRestoreData(id), { chatId: GROUP_ID, messageId: 70 });
    expect(deletedAtOf(db, id)).toBeNull();
  });

  it('opens the DM card from the deep link for its author only', async () => {
    const { db, calls, say, dm } = await bound();
    await say(ALLOWED_ID, '5 минут буду', 14, { firstName: 'Анна' });
    await say(STRANGER_ID, '2 минуты буду', 13, { firstName: 'Борис' });
    const a = expenseIdOf(db, 14);
    const b = expenseIdOf(db, 13);
    calls.length = 0;

    await dm(ALLOWED_ID, `/start e_${a}`, 80);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: messages.expenseRecorded({
            expense: {
              amountMinor: 500,
              currency: 'RSD',
              description: 'минут буду',
              category: { name: 'Другое' },
              occurredOn: TODAY,
            },
            ledger: { kind: 'shared', name: 'Семья' },
            sentOn: TODAY,
          }),
          reply_markup: {
            inline_keyboard: [
              [
                { text: messages.categoryButton, callback_data: `exp:cat:${a}` },
                { text: messages.editButton, callback_data: `exp:edit:${a}` },
              ],
              [{ text: messages.undoButton, callback_data: `exp:undo:${a}` }],
            ],
          },
          ...htmlParseMode,
        },
      },
    ]);

    calls.length = 0;
    await dm(ALLOWED_ID, `/start e_${b}`, 81);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: ALLOWED_ID,
      text: messages.welcome({ timezone: 'Europe/Belgrade', currency: 'RSD' }),
    });

    calls.length = 0;
    await dm(STRANGER_ID, `/start e_${b}`, 82);
    expect(calls).toEqual([]);
  });

  it("refuses A's undo, category change and amount edit of B's group expense in the service, writing nothing", async () => {
    const { db, say } = await bound();
    await say(STRANGER_ID, '2 минуты буду', 13, { firstName: 'Борис' });
    const expenseId = expenseIdOf(db, 13);
    const deps = {
      db,
      logger: createLogger('silent'),
      newId: () => 'unused',
      defaultTimezone: 'Europe/Belgrade',
    };
    const a = findUserByIdentity(db, 'telegram', String(ALLOWED_ID)) as User;
    const cafe = db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .pluck()
      .get(groupLedgerId(db)) as CategoryId;
    const row = () => db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
    const before = row();

    expect(undoExpense(deps, { user: a, expenseId, now: NOW })).toEqual({ kind: 'forbidden' });
    expect(changeCategory(deps, { user: a, expenseId, categoryId: cafe, now: NOW })).toEqual({
      kind: 'forbidden',
    });
    expect(openEdit(deps, { user: a, expenseId })).toEqual({ kind: 'forbidden' });
    expect(startEdit(deps, { user: a, expenseId, kind: 'editAmount', now: NOW })).toEqual({
      kind: 'forbidden',
    });

    expect(row()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) FROM flow_sessions').pluck().get()).toBe(0);
  });

  it("shows B's card for a /card reply, and nothing for a reply to a message that recorded nothing", async () => {
    const { db, calls, say, send } = await bound();
    await say(STRANGER_ID, '300 такси', 11, { firstName: 'Борис' });
    await say(STRANGER_ID, 'привет всем', 12, { firstName: 'Борис' });
    const id = expenseIdOf(db, 11);
    const cardReply = (replyTo: number, messageId: number) =>
      send((updateId) =>
        groupMessageUpdate({
          updateId,
          fromId: ALLOWED_ID,
          messageId,
          date: NOW,
          content: {
            text: '/card',
            entities: [{ type: 'bot_command', offset: 0, length: 5 }],
            reply_to_message: {
              message_id: replyTo,
              date: Math.floor(NOW.getTime() / 1000),
              chat: { id: GROUP_ID, type: 'supergroup', title: 'Семья' },
              from: { id: STRANGER_ID, is_bot: false, first_name: 'Борис' },
            },
          },
        }),
      );
    calls.length = 0;

    await cardReply(11, 90);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: GROUP_ID,
          text: messages.groupExpenseCard({
            author: 'Борис',
            expense: {
              amountMinor: 30000,
              currency: 'RSD',
              description: 'такси',
              category: { name: 'Транспорт' },
              occurredOn: TODAY,
            },
            sentOn: TODAY,
          }),
          reply_parameters: { message_id: 11 },
          reply_markup: {
            inline_keyboard: [[{ text: messages.undoButton, callback_data: `grp:del:${id}` }]],
          },
          ...htmlParseMode,
        },
      },
    ]);

    calls.length = 0;
    await cardReply(12, 91);
    expect(calls).toEqual([]);
  });

  it('keeps every grp: callback datum within 64 bytes', () => {
    const id = 'ffffffff-ffff-4fff-bfff-ffffffffffff' as ExpenseId;
    for (const data of [groupDeleteData(id), groupRestoreData(id)]) {
      expect(assertCallbackData(data)).toBe(data);
      expect(Buffer.byteLength(data, 'utf8')).toBe(44);
    }
  });
});

// Thursday 15 October, 12:00 in Belgrade.
const OCT_NOW = new Date('2026-10-15T10:00:00Z');
const OCTOBER = monthOf('2026-10-01' as LocalDate);
const SEPTEMBER = monthOf('2026-09-01' as LocalDate);
const GROUP_LEDGER = { kind: 'shared', name: 'Семья' } as const;

// A DM screen stores its anchor from the sent message, so the fake answers sendMessage with a
// message: id SENT_ID in the chat it was sent to.
const SENT_ID = 500;

function returnSentMessages(bot: Bot) {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (method !== 'sendMessage') return response;
    const chat = { id: (payload as { chat_id?: number }).chat_id, type: 'private' };
    return { ok: true, result: { message_id: SENT_ID, date: 0, chat, text: '' } as never };
  });
}

function sentText(call: { payload: unknown } | undefined): string {
  return (call?.payload as { text?: string } | undefined)?.text ?? '';
}

// The group ledger with A's `450 кафе` and `1200 продукты` and B's `300 такси` in October, and
// A's personal `999 секрет` on 10 October.
async function october() {
  const test = await bound({ now: OCT_NOW });
  await test.say(ALLOWED_ID, '450 кафе', 101, {
    firstName: 'Анна',
    date: new Date('2026-10-05T10:00:00Z'),
  });
  await test.say(ALLOWED_ID, '1200 продукты', 102, {
    firstName: 'Анна',
    date: new Date('2026-10-06T10:00:00Z'),
  });
  await test.say(STRANGER_ID, '300 такси', 103, {
    firstName: 'Борис',
    date: new Date('2026-10-07T10:00:00Z'),
  });
  await test.dm(ALLOWED_ID, '999 секрет', 104, new Date('2026-10-10T10:00:00Z'));
  test.calls.length = 0;
  return test;
}

describe('group reports (Phase 3)', () => {
  it('shows the group month by category and by person, without the personal ledger', async () => {
    const { calls, say } = await october();

    await say(STRANGER_ID, '/month', 110, { date: OCT_NOW });

    const expected = messages.periodSummary({
      ledger: GROUP_LEDGER,
      period: OCTOBER,
      currencies: [
        {
          currency: 'RSD',
          totalMinor: 195000,
          lines: [
            { name: 'Продукты', amountMinor: 120000 },
            { name: 'Кафе и рестораны', amountMinor: 45000 },
            { name: 'Транспорт', amountMinor: 30000 },
          ],
        },
      ],
      people: [
        { name: 'Анна', totals: [{ currency: 'RSD', amountMinor: 165000 }] },
        { name: 'Борис', totals: [{ currency: 'RSD', amountMinor: 30000 }] },
      ],
    });
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: GROUP_ID,
          text: expected,
          reply_markup: {
            inline_keyboard: [
              [{ text: messages.periodPrev(SEPTEMBER), callback_data: 'sum:m:2026-09' }],
            ],
          },
          ...htmlParseMode,
        },
      },
    ]);
    // 45000 + 120000 + 30000 = 195000; A: 45000 + 120000 = 165000.
    expect(expected).toContain('<b>1 950.00 RSD</b>');
    expect(expected).toContain('Анна: 1 650.00 RSD');
    expect(expected).toContain('Борис: 300.00 RSD');
    expect(expected).not.toContain('999');
    expect(expected).not.toContain('секрет');
  });

  it("shows A's DM month from the personal ledger alone", async () => {
    const { bot, calls, dm } = await october();
    returnSentMessages(bot);

    await dm(ALLOWED_ID, '/month', 111, OCT_NOW);

    expect(sentText(calls.at(-1))).toBe(
      messages.periodSummary({
        ledger: { kind: 'personal', name: 'Personal' },
        period: OCTOBER,
        currencies: [
          { currency: 'RSD', totalMinor: 99900, lines: [{ name: 'Другое', amountMinor: 99900 }] },
        ],
      }),
    );
    expect(sentText(calls.at(-1))).toContain('999.00 RSD');
  });

  // Property: a member who spent in two currencies gets one total per currency. RSD and EUR are
  // never added together (ADR-0003 conversion is out of scope).
  it('lists each currency of a member separately', async () => {
    const { calls, say } = await october();
    await say(ALLOWED_ID, '12,50 EUR такси', 105, { firstName: 'Анна', date: OCT_NOW });
    calls.length = 0;

    await say(ALLOWED_ID, '/month', 112, { date: OCT_NOW });

    expect(sentText(calls[0])).toContain('Анна: 1 650.00 RSD, 12.50 EUR');
    expect(sentText(calls[0])).toContain('Борис: 300.00 RSD');
  });

  it('pages the group month in place when B taps, writing no flow state for B', async () => {
    const { db, calls, say, tap } = await october();
    await say(STRANGER_ID, '/month', 113);
    calls.length = 0;

    await tap(STRANGER_ID, 'sum:m:2026-09', { chatId: GROUP_ID, messageId: 120 });

    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) as unknown },
      },
      {
        method: 'editMessageText',
        payload: {
          chat_id: GROUP_ID,
          message_id: 120,
          text: messages.periodSummary({
            ledger: GROUP_LEDGER,
            period: SEPTEMBER,
            currencies: [],
            people: [],
          }),
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: messages.periodPrev(monthOf('2026-08-01' as LocalDate)),
                  callback_data: 'sum:m:2026-08',
                },
                { text: messages.periodNext(OCTOBER), callback_data: 'sum:m:2026-10' },
              ],
            ],
          },
          ...htmlParseMode,
        },
      },
    ]);
    const b = userOf(db, STRANGER_ID);
    expect(
      db.prepare('SELECT COUNT(*) FROM flow_sessions WHERE user_id = ?').pluck().get(b?.id),
    ).toBe(0);
  });

  it("counts an expense sent at 23:30 UTC on 30 September in the ledger's October", async () => {
    const { calls, say, dm, tap, db } = await bound({ now: OCT_NOW });
    await dm(SECOND_ALLOWED_ID, '/start', 1);
    db.prepare("UPDATE users SET timezone = 'America/New_York'").run();
    await say(SECOND_ALLOWED_ID, '500 такси', 14, {
      firstName: 'Вера',
      date: new Date('2026-09-30T23:30:00Z'),
    });
    calls.length = 0;

    await say(ALLOWED_ID, '/month', 130);
    await tap(ALLOWED_ID, 'sum:m:2026-09', { chatId: GROUP_ID, messageId: 131 });

    expect(sentText(calls[0])).toContain('Вера: 500.00 RSD');
    expect(sentText(calls[2])).toBe(
      messages.periodSummary({
        ledger: GROUP_LEDGER,
        period: SEPTEMBER,
        currencies: [],
        people: [],
      }),
    );
  });

  it("shows a member's first name as literal text", async () => {
    const { calls, say } = await bound({ now: OCT_NOW });
    await say(THIRD_ID, '300 такси', 140, { firstName: '<b>Ира</b>', date: OCT_NOW });
    calls.length = 0;

    await say(ALLOWED_ID, '/month', 141, { date: OCT_NOW });

    expect(sentText(calls[0])).toContain('&lt;b&gt;Ира&lt;/b&gt;: 300.00 RSD');
    expect(sentText(calls[0])).not.toContain('<b>Ира</b>');
  });

  it('answers /help with the group help text and no menu keyboard', async () => {
    const { calls, say } = await bound();

    await say(STRANGER_ID, '/help', 150);

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: { chat_id: GROUP_ID, text: messages.groupHelp, ...htmlParseMode },
      },
    ]);
  });
});

function sharedLedgerCount(db: Db, ownerTelegramId: number): unknown {
  return db
    .prepare("SELECT COUNT(*) FROM ledgers WHERE kind = 'shared' AND owner_user_id = ?")
    .pluck()
    .get(userOf(db, ownerTelegramId)?.id);
}

function ledgerTimezone(db: Db): unknown {
  return db.prepare("SELECT timezone FROM ledgers WHERE kind = 'shared'").pluck().get();
}

describe('group lifecycle and ledger settings (Phase 4)', () => {
  const memberChange = (
    test: ReturnType<typeof harness>,
    fromId: number,
    oldStatus: 'left' | 'kicked' | 'member',
    newStatus: 'left' | 'kicked' | 'member',
  ) => test.send((id) => myChatMemberUpdate({ updateId: id, fromId, oldStatus, newStatus }));

  it.each(['left', 'kicked'] as const)(
    'deactivates the binding when the bot is %s, keeping the ledger and its expenses',
    async (status) => {
      const test = await bound();
      const { db, calls, say } = test;
      await say(STRANGER_ID, '300 такси', 11, { firstName: 'Борис' });
      const ledgers = db.prepare('SELECT * FROM ledgers ORDER BY id').all();
      const expenses = db.prepare('SELECT * FROM expenses ORDER BY id').all();

      await memberChange(test, ALLOWED_ID, 'member', status);
      calls.length = 0;
      await say(ALLOWED_ID, '450 кафе', 12, { firstName: 'Анна' });

      expect(db.prepare('SELECT active FROM ledger_chats').pluck().all()).toEqual([0]);
      expect(calls).toEqual([]);
      expect(db.prepare('SELECT * FROM ledgers ORDER BY id').all()).toEqual(ledgers);
      expect(db.prepare('SELECT * FROM expenses ORDER BY id').all()).toEqual(expenses);
    },
  );

  it('reactivates the same binding and ledger when A re-adds the bot; B re-adding makes it leave', async () => {
    const test = await bound();
    const { db, calls } = test;
    const binding = db.prepare('SELECT ledger_id, bound_at FROM ledger_chats').get();

    await memberChange(test, ALLOWED_ID, 'member', 'kicked');
    calls.length = 0;
    await memberChange(test, STRANGER_ID, 'kicked', 'member');
    expect(calls).toEqual([{ method: 'leaveChat', payload: { chat_id: GROUP_ID } }]);
    expect(db.prepare('SELECT active FROM ledger_chats').pluck().all()).toEqual([0]);

    calls.length = 0;
    await memberChange(test, ALLOWED_ID, 'left', 'member');
    expect(db.prepare('SELECT ledger_id, bound_at FROM ledger_chats').get()).toEqual(binding);
    expect(db.prepare('SELECT active FROM ledger_chats').pluck().all()).toEqual([1]);
    expect(sharedLedgerCount(db, ALLOWED_ID)).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
  });

  it("moves the binding on a supergroup migration, so B's next expense lands in the same ledger", async () => {
    const { db, send, say } = await bound();
    const ledgerId = groupLedgerId(db);

    await send((id) =>
      groupMessageUpdate({
        updateId: id,
        messageId: 160,
        content: { migrate_to_chat_id: -100999 },
      }),
    );
    await say(STRANGER_ID, '300 такси', 161, { firstName: 'Борис', chatId: -100999 });

    expect(db.prepare('SELECT chat_id, ledger_id FROM ledger_chats').all()).toEqual([
      { chat_id: '-100999', ledger_id: ledgerId },
    ]);
    expect(expensesIn(db, ledgerId)).toMatchObject([
      { amount_minor: 30000, source_key: 'tg:-100999:161' },
    ]);
  });

  it("gives A's /settings a DM deep link and B's the owner-only refusal", async () => {
    const { db, calls, say } = await bound();
    await say(STRANGER_ID, '300 такси', 11, { firstName: 'Борис' });
    const ledgerId = groupLedgerId(db);
    calls.length = 0;

    await say(ALLOWED_ID, '/settings', 170);
    await say(STRANGER_ID, '/settings', 171);
    await say(THIRD_ID, '/settings', 172);

    const link = `https://t.me/test_bot?start=gs_${ledgerId}`;
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: GROUP_ID,
          text: messages.groupSettingsLink,
          reply_markup: { inline_keyboard: [[{ text: messages.groupSettingsButton, url: link }]] },
          ...htmlParseMode,
        },
      },
      {
        method: 'sendMessage',
        payload: { chat_id: GROUP_ID, text: messages.groupSettingsOwnerOnly, ...htmlParseMode },
      },
      {
        method: 'sendMessage',
        payload: { chat_id: GROUP_ID, text: messages.groupSettingsOwnerOnly, ...htmlParseMode },
      },
    ]);
    expect(Buffer.byteLength(`gs_${ledgerId}`, 'utf8')).toBe(39);
    expect(userOf(db, THIRD_ID)).toBeUndefined();
  });

  it("sets the group ledger's timezone from A's DM screen, leaving A's own zone and earlier rows", async () => {
    const test = await bound({ now: new Date('2026-10-20T03:00:00Z') });
    const { bot, db, calls, say, dm, tap } = test;
    returnSentMessages(bot);
    await say(STRANGER_ID, '300 такси', 11, {
      firstName: 'Борис',
      date: new Date('2026-10-01T10:00:00Z'),
    });
    const ledgerId = groupLedgerId(db);
    calls.length = 0;

    await dm(ALLOWED_ID, `/start gs_${ledgerId}`, 180);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: ALLOWED_ID,
      text: messages.ledgerSettingsScreen({
        timezone: 'Europe/Belgrade',
        ledger: { kind: 'shared', name: 'Семья', defaultCurrency: 'RSD' },
      }),
    });
    await tap(ALLOWED_ID, 'set:tzother', { messageId: SENT_ID });
    await dm(ALLOWED_ID, 'America/New_York', 181);

    expect(ledgerTimezone(db)).toBe('America/New_York');
    expect(userOf(db, ALLOWED_ID)?.timezone).toBe('Europe/Belgrade');
    expect(sentText(calls.at(-1))).toBe(
      messages.ledgerSettingsScreen({
        timezone: 'America/New_York',
        ledger: { kind: 'shared', name: 'Семья', defaultCurrency: 'RSD' },
      }),
    );

    // 22:00 on 19 October in New York (EDT, UTC-4).
    await say(ALLOWED_ID, '450 кафе', 182, {
      firstName: 'Анна',
      date: new Date('2026-10-20T02:00:00Z'),
    });
    expect(expensesIn(db, ledgerId)).toMatchObject([
      { source_key: `tg:${GROUP_ID}:11`, occurred_on: '2026-10-01' },
      { source_key: `tg:${GROUP_ID}:182`, occurred_on: '2026-10-19' },
    ]);
  });

  it("opens no settings screen for anyone but the owner's /start gs_", async () => {
    const { bot, db, calls, say, dm } = await bound();
    returnSentMessages(bot);
    await say(STRANGER_ID, '300 такси', 11, { firstName: 'Борис' });
    await say(SECOND_ALLOWED_ID, '500 такси', 12, { firstName: 'Вера' });
    const ledgerId = groupLedgerId(db);
    calls.length = 0;

    await dm(STRANGER_ID, `/start gs_${ledgerId}`, 190);
    expect(calls).toEqual([]);

    await dm(SECOND_ALLOWED_ID, `/start gs_${ledgerId}`, 191);
    expect(calls).toHaveLength(1);
    expect(sentText(calls[0])).toBe(
      messages.welcome({ timezone: 'Europe/Belgrade', currency: 'RSD' }),
    );
    expect(
      db.prepare("SELECT COUNT(*) FROM flow_sessions WHERE screen = 'settings'").pluck().get(),
    ).toBe(0);
  });
});
