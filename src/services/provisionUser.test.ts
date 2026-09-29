import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { provisionUser, type ProvisionInput } from './provisionUser.js';

const NOW = new Date('2026-09-29T10:00:00Z');
const input: ProvisionInput = {
  provider: 'telegram',
  externalId: '1001',
  defaultTimezone: 'Europe/Belgrade',
  defaultCurrency: 'RSD',
  now: NOW,
};

let db: Db;
let n: number;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  n = 0;
});

function count(table: string): unknown {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
}

describe('provisionUser', () => {
  it('creates the user, identity, personal ledger, membership and active ledger once', () => {
    const first = provisionUser({ db, newId }, input);
    const second = provisionUser({ db, newId }, input);

    for (const table of ['users', 'auth_identities', 'ledgers', 'ledger_members']) {
      expect(count(table), table).toEqual({ n: 1 });
    }
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.user).toEqual(first.user);

    expect(db.prepare('SELECT id, timezone, active_ledger_id FROM users').get()).toEqual({
      id: first.user.id,
      timezone: 'Europe/Belgrade',
      active_ledger_id: first.ledger.id,
    });
    expect(db.prepare('SELECT provider, external_id, user_id FROM auth_identities').get()).toEqual({
      provider: 'telegram',
      external_id: '1001',
      user_id: first.user.id,
    });
    expect(db.prepare('SELECT kind, default_currency, owner_user_id FROM ledgers').get()).toEqual({
      kind: 'personal',
      default_currency: 'RSD',
      owner_user_id: first.user.id,
    });
    expect(db.prepare('SELECT ledger_id, user_id, role FROM ledger_members').get()).toEqual({
      ledger_id: first.ledger.id,
      user_id: first.user.id,
      role: 'owner',
    });
  });
});
