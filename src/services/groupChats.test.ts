import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import {
  answerGroupAsk,
  bindGroup,
  boundLedger,
  dueGroupAsks,
  expireGroupAsk,
  groupAskFor,
  migrateGroup,
  recordGroupExpense,
  saveGroupAsk,
  unbindGroup,
  type GroupDeps,
} from './groupChats.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const CHAT = -100500;
const ANNA = { telegramId: 1001, firstName: 'Аня' };
const BORIS = { telegramId: 2002, firstName: 'Борис' };

let db: Db;
let deps: GroupDeps;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
  };
});

function bind() {
  return bindGroup(deps, { chatId: CHAT, title: 'Семья', adder: ANNA, now: NOW });
}

function say(sender: typeof ANNA, text: string, messageId: number, at = NOW) {
  return recordGroupExpense(deps, {
    chatId: CHAT,
    sender,
    text,
    sourceKey: `tg:${CHAT}:${messageId}`,
    occurredAt: at,
    now: at,
  });
}

function count(table: string): unknown {
  return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
}

describe('bindGroup', () => {
  it("creates a shared ledger in the adder's currency and timezone, owned by them, bound once", () => {
    const result = bind();

    expect(result).toMatchObject({ kind: 'bound', created: true });
    expect(
      db
        .prepare("SELECT name, default_currency, timezone FROM ledgers WHERE kind = 'shared'")
        .all(),
    ).toEqual([{ name: 'Семья', default_currency: 'RSD', timezone: 'Europe/Belgrade' }]);
    expect(
      db
        .prepare('SELECT role, display_name FROM ledger_members WHERE ledger_id = ?')
        .all(result.ledger.id),
    ).toEqual([{ role: 'owner', display_name: 'Аня' }]);
    expect(db.prepare('SELECT chat_id, ledger_id, active FROM ledger_chats').all()).toEqual([
      { chat_id: String(CHAT), ledger_id: result.ledger.id, active: 1 },
    ]);
    expect(
      db
        .prepare('SELECT COUNT(*) FROM categories WHERE ledger_id = ?')
        .pluck()
        .get(result.ledger.id),
    ).toBeGreaterThan(0);
  });

  it('returns the bound ledger for a repeat and writes nothing', () => {
    const first = bind();
    const second = bind();

    expect(second).toEqual({
      kind: 'bound',
      ledger: first.ledger,
      created: false,
      reactivated: false,
    });
    expect(count('ledger_chats')).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM ledgers WHERE kind = 'shared'").pluck().get()).toBe(1);
  });

  it('reactivates the same binding and ledger after the bot was removed', () => {
    const first = bind();
    say(BORIS, '300 такси', 1);

    expect(unbindGroup(deps, CHAT)).toBe(true);
    expect(unbindGroup(deps, CHAT)).toBe(false);
    expect(boundLedger(deps, CHAT)).toBeUndefined();
    expect(count('expenses')).toBe(1);

    expect(bind()).toEqual({
      kind: 'bound',
      ledger: first.ledger,
      created: false,
      reactivated: true,
    });
    expect(db.prepare('SELECT chat_id, ledger_id, active FROM ledger_chats').all()).toEqual([
      { chat_id: String(CHAT), ledger_id: first.ledger.id, active: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) FROM ledgers WHERE kind = 'shared'").pluck().get()).toBe(1);
  });
});

describe('migrateGroup', () => {
  it('moves the binding to the new chat id once', () => {
    const { ledger } = bind();

    expect(migrateGroup(deps, { from: CHAT, to: -100999 })).toBe(true);
    expect(migrateGroup(deps, { from: CHAT, to: -100999 })).toBe(false);

    expect(boundLedger(deps, CHAT)).toBeUndefined();
    expect(boundLedger(deps, -100999)?.id).toBe(ledger.id);
  });
});

describe('recordGroupExpense', () => {
  it('ignores any text in an unbound chat and creates no user', () => {
    expect(say(BORIS, '300 такси', 1)).toEqual({ kind: 'ignored' });
    expect(count('users')).toBe(0);
  });

  it('ignores chatter and stores nothing for its sender', () => {
    bind();
    const users = count('users');

    expect(say(BORIS, 'привет всем', 2)).toEqual({ kind: 'ignored' });
    expect(count('users')).toBe(users);
    expect(count('expenses')).toBe(0);
  });

  it("provisions a first-time sender in the ledger's timezone and records in the bound ledger", () => {
    const { ledger } = bind();

    const result = say(BORIS, '300 такси', 3);

    expect(result).toMatchObject({ kind: 'recorded', duplicate: false, sentOn: '2026-09-30' });
    const boris = db
      .prepare(
        `SELECT u.id, u.timezone, u.active_ledger_id FROM users u
           JOIN auth_identities i ON i.user_id = u.id WHERE i.external_id = '2002'`,
      )
      .get() as { id: string; timezone: string; active_ledger_id: string };
    expect(boris.timezone).toBe('Europe/Belgrade');
    expect(
      db
        .prepare('SELECT kind FROM ledgers WHERE id = ? AND owner_user_id = ?')
        .pluck()
        .get(boris.active_ledger_id, boris.id),
    ).toBe('personal');
    expect(
      db
        .prepare(
          'SELECT role, display_name FROM ledger_members WHERE ledger_id = ? AND user_id = ?',
        )
        .get(ledger.id, boris.id),
    ).toEqual({ role: 'member', display_name: 'Борис' });
    expect(
      db.prepare('SELECT ledger_id, created_by, amount_minor, currency FROM expenses').all(),
    ).toEqual([
      { ledger_id: ledger.id, created_by: boris.id, amount_minor: 30000, currency: 'RSD' },
    ]);
  });

  it('stops routing once nothing is bound to the chat', () => {
    bind();
    db.prepare('UPDATE ledger_chats SET active = 0').run();

    expect(boundLedger(deps, CHAT)).toBeUndefined();
    expect(say(BORIS, '300 такси', 4)).toEqual({ kind: 'ignored' });
    expect(count('expenses')).toBe(0);
  });
});

describe('group questions to amount-last text (ADR-0046)', () => {
  const offer = (text: string, messageId = 11, at = NOW) =>
    groupAskFor(deps, { chatId: CHAT, messageId, text, occurredAt: at });
  const save = (messageId = 11, now = NOW) => {
    const ledger = boundLedger(deps, CHAT);
    if (ledger === undefined) throw new Error('setup: not bound');
    return saveGroupAsk(deps, {
      chatId: CHAT,
      messageId,
      ledgerId: ledger.id,
      senderTelegramId: ANNA.telegramId,
      text: 'Чайник 3200',
      sentAt: NOW,
      askMessageId: 500 + messageId,
      now,
    });
  };
  const answer = (tapper: typeof ANNA, kind: 'record' | 'dismiss', messageId = 11) =>
    answerGroupAsk(deps, { chatId: CHAT, messageId, tapper, answer: kind, now: NOW });

  it('offers Чайник 3200 as 3 200.00 RSD and stores nothing', () => {
    const { ledger } = bind();

    expect(offer('Чайник 3200')).toEqual({
      ledger,
      money: { amountMinor: 320000, currency: 'RSD' },
      description: 'Чайник',
      date: '2026-09-30',
      sentOn: '2026-09-30',
    });
    expect(count('group_asks')).toBe(0);
    expect(count('expenses')).toBe(0);
  });

  it.each(['3200 чайник', 'буду в 7', 'Через 10', 'Будешь в 7?', 'Лампа 1.500', 'привет'])(
    'offers no question for %j',
    (text) => {
      bind();
      expect(offer(text)).toBeUndefined();
    },
  );

  it('offers nothing in an unbound chat, or for a message asked about already', () => {
    expect(offer('Чайник 3200')).toBeUndefined();
    bind();
    expect(save()).toBe(true);
    expect(save()).toBe(false);
    expect(offer('Чайник 3200')).toBeUndefined();
  });

  it('records the sender’s [Записать] once, dated by the message, and deletes the row', () => {
    bind();
    save();

    expect(answer(ANNA, 'record')).toMatchObject({ kind: 'recorded' });
    expect(answer(ANNA, 'record')).toEqual({ kind: 'alreadyRecorded' });
    expect(
      db.prepare('SELECT amount_minor, description, occurred_at, source_key FROM expenses').all(),
    ).toEqual([
      {
        amount_minor: 320000,
        description: 'Чайник',
        occurred_at: '2026-09-30T10:00:00.000Z',
        source_key: `tg:${CHAT}:11`,
      },
    ]);
    expect(count('group_asks')).toBe(0);
  });

  it('refuses anyone but the sender and keeps the question', () => {
    bind();
    save();

    expect(answer(BORIS, 'record')).toEqual({ kind: 'notSender' });
    expect(answer(BORIS, 'dismiss')).toEqual({ kind: 'notSender' });
    expect(count('group_asks')).toBe(1);
    expect(count('expenses')).toBe(0);
  });

  it('dismisses, then answers gone, recording nothing', () => {
    bind();
    save();

    expect(answer(ANNA, 'dismiss')).toEqual({ kind: 'dismissed' });
    expect(answer(ANNA, 'record')).toEqual({ kind: 'gone' });
    expect(count('group_asks')).toBe(0);
    expect(count('expenses')).toBe(0);
  });

  it('expires a question 15 minutes after it was asked, once', () => {
    bind();
    save(11, new Date('2026-09-30T10:00:00Z'));

    expect(dueGroupAsks(deps, new Date('2026-09-30T10:14:59Z'))).toEqual([]);
    const [due] = dueGroupAsks(deps, new Date('2026-09-30T10:15:00Z'));
    expect(due).toMatchObject({ messageId: 11, askMessageId: 511 });
    if (due === undefined) return;
    expect(expireGroupAsk(deps, due)).toBe(true);
    expect(expireGroupAsk(deps, due)).toBe(false);
    expect(count('group_asks')).toBe(0);
  });
});
