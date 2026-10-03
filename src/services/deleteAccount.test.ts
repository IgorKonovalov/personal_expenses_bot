import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { decodeRsUrl } from '../domain/receipts/rsUrl.js';
import { buildRsUrl } from '../domain/receipts/testing/buildRsVl.js';
import { createLogger } from '../logger.js';
import { deleteAccount, isAccountDeleted } from './deleteAccount.js';
import { fetchDueReceipt, type FetchDeps } from './fetchDueReceipt.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordReceipt } from './recordReceipt.js';
import { sealPersonalLedger } from './testing/sealLedger.js';

const NOW = new Date('2026-10-01T08:00:00Z');

let db: Db;
let keys: LedgerKeyring;
let alice: User;
let fetcherCalls: number;

function deps(): FetchDeps & { keys: LedgerKeyring } {
  let n = 100;
  return {
    db,
    keys,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    fetchers: {
      RS: () => {
        fetcherCalls++;
        return Promise.resolve({ kind: 'failed', reason: 'network' });
      },
      ME: () => Promise.reject(new Error('unused')),
    },
    placeholder: 'Чек',
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  keys = createLedgerKeyring(() => NOW);
  fetcherCalls = 0;
  alice = provisionUser(deps(), {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
});

describe('deleteAccount', () => {
  it('leaves the receipt worker nothing to fetch for a deleted pending receipt', async () => {
    const decoded = decodeRsUrl(buildRsUrl());
    if (decoded.kind !== 'receipt') throw new Error('synthetic receipt did not decode');
    recordReceipt(deps(), {
      user: alice,
      receipt: decoded.receipt,
      placeholder: 'Чек',
      occurredAt: NOW,
      now: NOW,
    });
    expect(
      db.prepare("SELECT COUNT(*) FROM receipts WHERE fetch_state = 'pending'").pluck().get(),
    ).toBe(1);

    expect(deleteAccount(deps(), { telegramId: 1001, now: NOW })).toBe('deleted');

    const result = await fetchDueReceipt(deps(), {
      now: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: 'idle' });
    expect(fetcherCalls).toBe(0);
  });

  it('deletes a sealed ledger with its key rows, and answers a second call as already deleted', async () => {
    await sealPersonalLedger(deps(), alice, NOW);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_keys').pluck().get()).toBe(1);

    expect(deleteAccount(deps(), { telegramId: 1001, now: NOW })).toBe('deleted');
    expect(deleteAccount(deps(), { telegramId: 1001, now: NOW })).toBe('alreadyDeleted');

    expect(db.prepare('SELECT COUNT(*) FROM ledger_keys').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_key_wraps').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM ledgers').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM flow_sessions').pluck().get()).toBe(0);
    expect(isAccountDeleted(deps(), alice.id)).toBe(true);
  });
});
