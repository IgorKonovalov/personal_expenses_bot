import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { countRedemptions, findInviteCode, insertInviteCode, insertRedemption } from './invites.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T10:00:00Z');
const EXPIRES = new Date('2026-10-15T10:00:00Z');
const USER = 'user-a' as UserId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertInviteCode(db, { code: 'abcdefghijk', maxUses: 10, expiresAt: EXPIRES, createdAt: NOW });
});

describe('invite codes', () => {
  it('reads back what was inserted', () => {
    expect(findInviteCode(db, 'abcdefghijk')).toEqual({
      code: 'abcdefghijk',
      maxUses: 10,
      expiresAt: EXPIRES,
      revokedAt: null,
      createdAt: NOW,
    });
    expect(findInviteCode(db, 'missing')).toBeUndefined();
  });

  it('rejects a use limit outside 1..1000', () => {
    expect(() => {
      insertInviteCode(db, { code: 'x', maxUses: 1001, expiresAt: EXPIRES, createdAt: NOW });
    }).toThrow(/CHECK/);
  });

  it('records one redemption per user and code', () => {
    expect(insertRedemption(db, { code: 'abcdefghijk', userId: USER, redeemedAt: NOW })).toBe(true);
    expect(insertRedemption(db, { code: 'abcdefghijk', userId: USER, redeemedAt: NOW })).toBe(
      false,
    );
    expect(countRedemptions(db, 'abcdefghijk')).toBe(1);
  });
});
