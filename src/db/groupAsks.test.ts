import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import {
  deleteGroupAsk,
  deleteSenderGroupAsks,
  findGroupAsk,
  insertGroupAsk,
  listGroupAsksCreatedBy,
  type GroupAsk,
} from './groupAsks.js';
import { insertLedger, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-07T10:00:00Z');
const OWNER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: OWNER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertLedger(db, {
    id: LEDGER,
    kind: 'shared',
    name: 'Family',
    defaultCurrency: 'RSD',
    timezone: 'Europe/Belgrade',
    ownerUserId: OWNER,
    createdAt: NOW,
  });
});

function ask(messageId: number, overrides: Partial<GroupAsk> = {}): GroupAsk {
  return {
    chatId: '-100500',
    messageId,
    ledgerId: LEDGER,
    senderTelegramId: '1001',
    text: 'Синтетика 3200',
    sentAt: new Date('2026-10-07T09:59:00Z'),
    askMessageId: messageId + 100,
    createdAt: NOW,
    ...overrides,
  };
}

describe('group_asks', () => {
  it('reads back a question by chat and message, and keeps the first of two inserts', () => {
    expect(insertGroupAsk(db, ask(11))).toBe(true);
    expect(insertGroupAsk(db, ask(11, { askMessageId: 999 }))).toBe(false);

    expect(findGroupAsk(db, '-100500', 11)).toEqual(ask(11));
    expect(findGroupAsk(db, '-100500', 12)).toBeUndefined();
  });

  it('deletes a question once: true the first time, false after', () => {
    insertGroupAsk(db, ask(11));

    expect(deleteGroupAsk(db, '-100500', 11)).toBe(true);
    expect(deleteGroupAsk(db, '-100500', 11)).toBe(false);
    expect(findGroupAsk(db, '-100500', 11)).toBeUndefined();
  });

  it('lists the questions created at or before the cutoff', () => {
    insertGroupAsk(db, ask(11, { createdAt: new Date('2026-10-07T10:00:00Z') }));
    insertGroupAsk(db, ask(12, { createdAt: new Date('2026-10-07T10:00:01Z') }));

    expect(
      listGroupAsksCreatedBy(db, new Date('2026-10-07T09:59:59Z')).map((a) => a.messageId),
    ).toEqual([]);
    expect(
      listGroupAsksCreatedBy(db, new Date('2026-10-07T10:00:00Z')).map((a) => a.messageId),
    ).toEqual([11]);
  });

  it("deletes one sender's questions and leaves the others'", () => {
    insertGroupAsk(db, ask(11));
    insertGroupAsk(db, ask(12, { senderTelegramId: '2002' }));

    deleteSenderGroupAsks(db, '1001');

    expect(db.prepare('SELECT message_id FROM group_asks').pluck().all()).toEqual([12]);
  });
});
