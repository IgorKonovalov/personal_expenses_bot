import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { findLedgerChat, insertLedgerChat } from './ledgerChats.js';
import { insertLedger, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-09-30T10:00:00Z');
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

const binding = {
  provider: 'telegram' as const,
  chatId: '-100500',
  ledgerId: LEDGER,
  active: true,
  boundBy: OWNER,
  boundAt: NOW,
};

describe('ledger_chats', () => {
  it('reads back a binding by provider and chat id', () => {
    insertLedgerChat(db, binding);

    expect(findLedgerChat(db, 'telegram', '-100500')).toEqual(binding);
    expect(findLedgerChat(db, 'telegram', '-100999')).toBeUndefined();
  });

  it('binds a ledger to at most one chat and a chat to at most one ledger', () => {
    insertLedgerChat(db, binding);

    expect(() => {
      insertLedgerChat(db, { ...binding, chatId: '-100999' });
    }).toThrow(/UNIQUE/);
    expect(() => {
      insertLedgerChat(db, binding);
    }).toThrow(/UNIQUE/);
  });
});
