import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { openDatabase, type Db } from './connection.js';
import {
  findDebtPerson,
  findDebtPersonByKey,
  insertDebtOpOrGetExisting,
  insertDebtPerson,
  listDebtOps,
  listDebtPeople,
  type DebtOpId,
  type NewDebtOp,
} from './debts.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-02T10:00:00Z');
const USER = 'u-1' as UserId;
const OTHER = 'u-2' as UserId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertUser(db, { id: OTHER, timezone: 'Europe/Belgrade', createdAt: NOW });
});

function person(userId: UserId, name: string) {
  return insertDebtPerson(db, { userId, name, nameKey: name.toLowerCase(), createdAt: NOW });
}

describe('debt people', () => {
  it('finds a person by their lower-cased name, only among the user’s own', () => {
    const petya = person(USER, 'Петя');
    person(OTHER, 'Петя');

    expect(findDebtPersonByKey(db, USER, 'петя')).toEqual(petya);
    expect(findDebtPerson(db, OTHER, petya.id)).toBeUndefined();
    expect(listDebtPeople(db, USER)).toEqual([petya]);
  });

  it('refuses a second person with the same name key', () => {
    person(USER, 'Петя');
    expect(() => person(USER, 'ПЕТЯ')).toThrow(/UNIQUE/);
  });
});

describe('debt operations', () => {
  function op(id: string, overrides: Partial<NewDebtOp> = {}): NewDebtOp {
    return {
      id: id as DebtOpId,
      userId: USER,
      personId: person(USER, `p${id}`).id,
      kind: 'lend',
      amountMinor: 500000,
      currency: 'RSD',
      occurredOn: '2026-10-02' as LocalDate,
      expenseId: null,
      sourceKey: `tg:1:${id}`,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('stores one operation per source key', () => {
    const first = insertDebtOpOrGetExisting(db, op('a'));
    const again = insertDebtOpOrGetExisting(db, op('b', { sourceKey: 'tg:1:a' }));

    expect(first.created).toBe(true);
    expect(again).toEqual({ op: first.op, created: false });
    expect(listDebtOps(db, USER)).toEqual([
      expect.objectContaining({ id: 'a', kind: 'lend', amountMinor: 500000, currency: 'RSD' }),
    ]);
  });
});
