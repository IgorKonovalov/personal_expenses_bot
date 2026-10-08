import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteChatImport,
  deleteExpiredChatImport,
  findChatImport,
  joinImportedMember,
  listExpiredChatImports,
  saveChatImport,
  updateChatImport,
  type ChatImportRow,
} from './chatImports.js';
import { openDatabase, type Db } from './connection.js';
import { insertLedger, insertMember, listMemberNames, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type User, type UserId } from './users.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const LEDGER = '30000000-0000-4000-8000-000000000001' as LedgerId;

let db: Db;
let alice: User;
let bob: User;

function user(id: string): User {
  insertUser(db, { id: id as UserId, timezone: 'Europe/Belgrade', createdAt: NOW });
  return { id: id as UserId, timezone: 'Europe/Belgrade', activeLedgerId: null };
}

function row(overrides: Partial<ChatImportRow> = {}): ChatImportRow {
  return {
    userId: alice.id,
    ledgerId: LEDGER,
    chatId: '-1001234567890',
    nonce: 'abc123',
    payload: '{}',
    noticeMessageId: null,
    expiresAt: new Date('2026-10-02T08:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  alice = user('10000000-0000-4000-8000-000000000001');
  bob = user('20000000-0000-4000-8000-000000000001');
  insertLedger(db, {
    id: LEDGER,
    kind: 'shared',
    name: 'Семья',
    defaultCurrency: 'RSD',
    timezone: 'Europe/Belgrade',
    ownerUserId: alice.id,
    createdAt: NOW,
  });
});

describe('chat_imports', () => {
  it('keeps one row per user: a second save replaces the first', () => {
    saveChatImport(db, row());
    saveChatImport(db, row({ nonce: 'zzz999', chatId: '-100777', payload: '{"b":1}' }));

    expect(findChatImport(db, alice.id)).toEqual(
      row({ nonce: 'zzz999', chatId: '-100777', payload: '{"b":1}' }),
    );
  });

  it('updates the row only under its own nonce', () => {
    saveChatImport(db, row());
    const later = new Date('2026-10-03T08:00:00Z');

    expect(updateChatImport(db, alice.id, 'other1', { payload: '{"x":1}', expiresAt: later })).toBe(
      false,
    );
    expect(updateChatImport(db, alice.id, 'abc123', { payload: '{"x":2}', expiresAt: later })).toBe(
      true,
    );
    expect(findChatImport(db, alice.id)).toMatchObject({ payload: '{"x":2}', expiresAt: later });
  });

  it('lists and deletes a row only once it is expired', () => {
    saveChatImport(db, row());
    saveChatImport(db, row({ userId: bob.id, expiresAt: new Date('2026-10-05T08:00:00Z') }));
    const at = new Date('2026-10-02T08:00:00Z');

    expect(listExpiredChatImports(db, new Date('2026-10-02T07:59:59Z'))).toEqual([]);
    expect(listExpiredChatImports(db, at)).toEqual([alice.id]);
    expect(deleteExpiredChatImport(db, bob.id, at)).toBe(false);
    expect(deleteExpiredChatImport(db, alice.id, at)).toBe(true);
    expect(deleteExpiredChatImport(db, alice.id, at)).toBe(false);
    expect(findChatImport(db, bob.id)).toBeDefined();
  });

  it('deletes the user’s row', () => {
    saveChatImport(db, row());

    expect(deleteChatImport(db, alice.id)).toBe(true);
    expect(deleteChatImport(db, alice.id)).toBe(false);
  });
});

describe('joinImportedMember', () => {
  it('adds a member under the export’s name, and keeps a name already stored', () => {
    insertMember(db, { ledgerId: LEDGER, userId: alice.id, role: 'owner', displayName: 'Анна' });

    joinImportedMember(db, { ledgerId: LEDGER, userId: alice.id, displayName: 'A', joinedAt: NOW });
    joinImportedMember(db, { ledgerId: LEDGER, userId: bob.id, displayName: 'B', joinedAt: NOW });
    joinImportedMember(db, { ledgerId: LEDGER, userId: bob.id, displayName: 'Б', joinedAt: NOW });

    expect(listMemberNames(db, LEDGER)).toEqual(
      new Map([
        [alice.id, 'Анна'],
        [bob.id, 'B'],
      ]),
    );
  });

  it('fills in a name for a member who had none', () => {
    insertMember(db, { ledgerId: LEDGER, userId: bob.id, role: 'member' });

    joinImportedMember(db, { ledgerId: LEDGER, userId: bob.id, displayName: 'B', joinedAt: NOW });

    expect(listMemberNames(db, LEDGER).get(bob.id)).toBe('B');
  });
});
