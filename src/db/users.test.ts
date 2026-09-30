import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { runMigrations } from './migrate.js';
import { insertUser, updateUserTimezone, type UserId } from './users.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const USER = 'user-a' as UserId;
const OTHER = 'user-b' as UserId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertUser(db, { id: OTHER, timezone: 'Europe/Belgrade', createdAt: NOW });
});

function timezoneOf(id: UserId): unknown {
  return db.prepare('SELECT timezone FROM users WHERE id = ?').pluck().get(id);
}

describe('updateUserTimezone', () => {
  it('stores the new zone for that user only and reports the write', () => {
    expect(updateUserTimezone(db, USER, 'Europe/Moscow')).toBe(true);
    expect(timezoneOf(USER)).toBe('Europe/Moscow');
    expect(timezoneOf(OTHER)).toBe('Europe/Belgrade');
  });

  it('writes nothing when the zone is already the stored one', () => {
    expect(updateUserTimezone(db, USER, 'Europe/Belgrade')).toBe(false);
    expect(timezoneOf(USER)).toBe('Europe/Belgrade');
  });
});
