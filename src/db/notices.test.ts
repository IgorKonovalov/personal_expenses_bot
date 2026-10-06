import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { runMigrations } from './migrate.js';
import { deleteUserNotices, insertNoticeSeen } from './notices.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-06T10:00:00Z');

let db: Db;

function user(id: string): UserId {
  insertUser(db, { id: id as UserId, timezone: 'Europe/Belgrade', createdAt: NOW });
  return id as UserId;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
});

describe('user notices repository', () => {
  it('inserts a notice once: true the first time, false after', () => {
    const id = user('1001');

    expect(insertNoticeSeen(db, id, 'stray_help', NOW)).toBe(true);
    expect(insertNoticeSeen(db, id, 'stray_help', new Date('2026-10-07T10:00:00Z'))).toBe(false);

    expect(db.prepare('SELECT notice, seen_at FROM user_notices').all()).toEqual([
      { notice: 'stray_help', seen_at: '2026-10-06T10:00:00.000Z' },
    ]);
  });

  it('keeps notices apart per key and per user', () => {
    const a = user('1001');
    const b = user('1002');
    insertNoticeSeen(db, a, 'stray_help', NOW);

    expect(insertNoticeSeen(db, a, 'edit_hint', NOW)).toBe(true);
    expect(insertNoticeSeen(db, b, 'stray_help', NOW)).toBe(true);
  });

  it("deletes one user's notices and leaves the others'", () => {
    const a = user('1001');
    const b = user('1002');
    insertNoticeSeen(db, a, 'stray_help', NOW);
    insertNoticeSeen(db, a, 'edit_hint', NOW);
    insertNoticeSeen(db, b, 'stray_help', NOW);

    deleteUserNotices(db, a);

    expect(db.prepare('SELECT user_id FROM user_notices').pluck().all()).toEqual([b]);
    expect(insertNoticeSeen(db, a, 'stray_help', NOW)).toBe(true);
  });
});
