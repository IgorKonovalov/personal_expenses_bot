import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';
import { deleteUserTips, insertTipShown, listTipsShown } from './userTips.js';

const NOW = new Date('2026-10-01T10:00:00Z');
const LATER = new Date('2026-10-02T10:00:00Z');

let db: Db;

function user(id: string): UserId {
  insertUser(db, { id: id as UserId, timezone: 'Europe/Belgrade', createdAt: NOW });
  return id as UserId;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
});

describe('user tips repository', () => {
  it('records a tip once: true the first time, false after, keeping the first instant', () => {
    const id = user('1001');

    expect(insertTipShown(db, id, 'tipOther', NOW)).toBe(true);
    expect(insertTipShown(db, id, 'tipOther', LATER)).toBe(false);

    expect(listTipsShown(db, id)).toEqual([{ tip: 'tipOther', shownAt: NOW }]);
  });

  it("lists one user's tips oldest first", () => {
    const a = user('1001');
    const b = user('1002');
    insertTipShown(db, a, 'tipForeign', LATER);
    insertTipShown(db, a, 'tipOther', NOW);
    insertTipShown(db, b, 'tipFirstExpense', NOW);

    expect(listTipsShown(db, a)).toEqual([
      { tip: 'tipOther', shownAt: NOW },
      { tip: 'tipForeign', shownAt: LATER },
    ]);
  });

  it("deletes one user's tips and leaves the others'", () => {
    const a = user('1001');
    const b = user('1002');
    insertTipShown(db, a, 'tipOther', NOW);
    insertTipShown(db, a, 'tipForeign', NOW);
    insertTipShown(db, b, 'tipOther', NOW);

    deleteUserTips(db, a);

    expect(listTipsShown(db, a)).toEqual([]);
    expect(listTipsShown(db, b)).toEqual([{ tip: 'tipOther', shownAt: NOW }]);
  });
});
