import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import {
  findMemberRole,
  findMemberStickyTag,
  insertLedger,
  insertMember,
  joinMember,
  listMembers,
  listMemberNames,
  setMemberStickyTag,
  updateLedgerCurrency,
  type LedgerId,
} from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const OWNER = 'user-a' as UserId;
const MEMBER = 'user-b' as UserId;
const STRANGER = 'user-c' as UserId;
const LEDGER = 'ledger-a' as LedgerId;
const OTHER_LEDGER = 'ledger-b' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  for (const id of [OWNER, MEMBER, STRANGER]) {
    insertUser(db, { id, timezone: 'Europe/Belgrade', createdAt: NOW });
  }
  for (const id of [LEDGER, OTHER_LEDGER]) {
    insertLedger(db, {
      id,
      kind: 'shared',
      name: 'Family',
      defaultCurrency: 'RSD',
      timezone: 'Europe/Belgrade',
      ownerUserId: OWNER,
      createdAt: NOW,
    });
  }
  insertMember(db, { ledgerId: LEDGER, userId: OWNER, role: 'owner' });
  insertMember(db, { ledgerId: LEDGER, userId: MEMBER, role: 'member' });
});

function currencyOf(id: LedgerId): unknown {
  return db.prepare('SELECT default_currency FROM ledgers WHERE id = ?').pluck().get(id);
}

describe('sticky tags (ADR-0029)', () => {
  it("sets, reads and clears one member's sticky tag, leaving the other member's", () => {
    expect(setMemberStickyTag(db, LEDGER, OWNER, 'отпуск')).toBe(true);
    expect(setMemberStickyTag(db, LEDGER, OWNER, 'отпуск')).toBe(false);

    expect(findMemberStickyTag(db, LEDGER, OWNER)).toBe('отпуск');
    expect(findMemberStickyTag(db, LEDGER, MEMBER)).toBeUndefined();
    expect(findMemberStickyTag(db, LEDGER, STRANGER)).toBeUndefined();

    expect(setMemberStickyTag(db, LEDGER, OWNER, null)).toBe(true);
    expect(setMemberStickyTag(db, LEDGER, OWNER, null)).toBe(false);
    expect(findMemberStickyTag(db, LEDGER, OWNER)).toBeUndefined();
  });
});

describe('insertLedger', () => {
  it('refuses a shared ledger without a timezone and stores nothing (ADR-0015)', () => {
    const id = 'ledger-c' as LedgerId;
    const shared = {
      id,
      kind: 'shared' as const,
      name: 'Family',
      defaultCurrency: 'RSD' as const,
      ownerUserId: OWNER,
      createdAt: NOW,
    };

    expect(() => {
      insertLedger(db, shared);
    }).toThrow('needs a timezone');
    expect(() => {
      insertLedger(db, { ...shared, timezone: null });
    }).toThrow('needs a timezone');
    expect(db.prepare('SELECT COUNT(*) FROM ledgers WHERE id = ?').pluck().get(id)).toBe(0);
  });

  it('stores a personal ledger with a NULL timezone', () => {
    const id = 'ledger-p' as LedgerId;
    insertLedger(db, {
      id,
      kind: 'personal',
      name: 'Personal',
      defaultCurrency: 'RSD',
      ownerUserId: OWNER,
      createdAt: NOW,
    });

    expect(db.prepare('SELECT timezone FROM ledgers WHERE id = ?').pluck().get(id)).toBeNull();
  });
});

describe('joinMember', () => {
  it('adds a member with a display name, then only refreshes the name, keeping the role', () => {
    const join = (userId: UserId, displayName: string, joinedAt: Date) =>
      joinMember(db, { ledgerId: LEDGER, userId, displayName, joinedAt });
    const joined = new Date('2026-10-05T10:00:00Z');
    expect(join(STRANGER, 'Ира', joined)).toBe(true);
    expect(join(STRANGER, 'Ирина', new Date('2026-10-09T10:00:00Z'))).toBe(false);
    expect(join(OWNER, 'Аня', joined)).toBe(false);
    expect(listMembers(db, LEDGER).find((m) => m.userId === STRANGER)?.joinedAt).toEqual(joined);

    expect(findMemberRole(db, LEDGER, STRANGER)).toBe('member');
    expect(findMemberRole(db, LEDGER, OWNER)).toBe('owner');
    expect(listMemberNames(db, LEDGER)).toEqual(
      new Map([
        [OWNER, 'Аня'],
        [MEMBER, null],
        [STRANGER, 'Ирина'],
      ]),
    );
  });
});

describe('findMemberRole', () => {
  it("reads the user's role, and undefined for a non-member", () => {
    expect(findMemberRole(db, LEDGER, OWNER)).toBe('owner');
    expect(findMemberRole(db, LEDGER, MEMBER)).toBe('member');
    expect(findMemberRole(db, LEDGER, STRANGER)).toBeUndefined();
  });
});

describe('updateLedgerCurrency', () => {
  it('stores the currency for that ledger only and reports the write', () => {
    expect(updateLedgerCurrency(db, LEDGER, 'EUR')).toBe(true);
    expect(currencyOf(LEDGER)).toBe('EUR');
    expect(currencyOf(OTHER_LEDGER)).toBe('RSD');
  });

  it('writes nothing when the currency is already the stored one', () => {
    expect(updateLedgerCurrency(db, LEDGER, 'RSD')).toBe(false);
    expect(currencyOf(LEDGER)).toBe('RSD');
  });
});
