import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import {
  findMemberRole,
  insertLedger,
  insertMember,
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
