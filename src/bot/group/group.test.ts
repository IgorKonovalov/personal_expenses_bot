import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/connection.js';
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

function harness(options: { readonly failMethods?: readonly string[] } = {}) {
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
async function bound(options: { readonly failMethods?: readonly string[] } = {}) {
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
