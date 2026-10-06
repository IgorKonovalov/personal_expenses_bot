import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { openDatabase, type Db } from './connection.js';
import {
  findDebtPerson,
  findDebtPersonByKey,
  insertDebtOpOrGetExisting,
  insertDebtPerson,
  insertSealedDebtPerson,
  listDebtOps,
  listDebtPeople,
  listPersonOps,
  softDeleteDebtOp,
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

  it('stores a sealed person and operation with NULL plaintext columns, and reads them back sealed', () => {
    const sealedPerson = insertSealedDebtPerson(db, {
      userId: USER,
      createdAt: NOW,
      seal: (id) => Buffer.from(`blob-${String(id)}`),
    });
    insertDebtOpOrGetExisting(db, {
      id: 'a' as DebtOpId,
      userId: USER,
      personId: sealedPerson.id,
      sealed: Buffer.from('op-blob'),
      occurredOn: '2026-10-02' as LocalDate,
      expenseId: null,
      sourceKey: 'tg:1:a',
      createdAt: NOW,
    });

    expect(findDebtPerson(db, USER, sealedPerson.id)).toEqual({
      id: sealedPerson.id,
      userId: USER,
      sealed: Buffer.from(`blob-${String(sealedPerson.id)}`),
    });
    expect(listDebtOps(db, USER)).toEqual([
      expect.objectContaining({ id: 'a', sealed: Buffer.from('op-blob') }),
    ]);
    expect(
      db.prepare('SELECT name, name_key FROM debt_people WHERE id = ?').get(sealedPerson.id),
    ).toEqual({ name: null, name_key: null });
    expect(db.prepare('SELECT kind, amount_minor, currency FROM debt_ops').get()).toEqual({
      kind: null,
      amount_minor: null,
      currency: null,
    });
  });

  it('lists a person’s live operations newest first, and soft-deletes one once', () => {
    const { id: personId } = person(USER, 'Петя');
    insertDebtOpOrGetExisting(db, op('a', { personId, occurredOn: '2026-10-01' as LocalDate }));
    insertDebtOpOrGetExisting(db, op('b', { personId, kind: 'repaid_to_me', amountMinor: 1 }));
    insertDebtOpOrGetExisting(db, op('c', { personId, amountMinor: 2 }));

    expect(softDeleteDebtOp(db, 'c' as DebtOpId, NOW)).toBe(true);
    expect(softDeleteDebtOp(db, 'c' as DebtOpId, NOW)).toBe(false);
    expect(listPersonOps(db, USER, personId, 10).map((o) => o.id)).toEqual(['b', 'a']);
    expect(listPersonOps(db, USER, personId, 1).map((o) => o.id)).toEqual(['b']);
  });
});
