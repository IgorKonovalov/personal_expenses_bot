import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import type { LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { TagName } from '../domain/tags.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense } from './recordExpense.js';
import { sealPersonalLedger } from './testing/sealLedger.js';
import {
  clearStickyTag,
  currentStickyTag,
  setStickyTag,
  stickyTagOf,
  withStickyTag,
} from './stickyTag.js';

const NOW = new Date('2026-09-30T10:00:00Z');

let db: Db;
let alice: User;
let personal: LedgerId;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  const provisioned = provisionUser(
    { db, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    {
      provider: 'telegram',
      externalId: '1001',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    },
  );
  alice = provisioned.user;
  personal = provisioned.ledger.id;
});

describe('setStickyTag', () => {
  it('normalizes the name, with or without its #, in the active ledger', () => {
    expect(setStickyTag({ db }, alice, ' #Отпуск ')).toMatchObject({
      kind: 'set',
      name: 'отпуск',
      ledger: { id: personal },
    });
    expect(stickyTagOf({ db }, personal, alice.id)).toBe('отпуск');
    expect(currentStickyTag({ db }, alice)).toMatchObject({ name: 'отпуск' });
  });

  it.each(['#', 'два слова', 'a-b', 'я'.repeat(33)])('refuses %j', (text) => {
    expect(setStickyTag({ db }, alice, text)).toEqual({ kind: 'invalid' });
    expect(stickyTagOf({ db }, personal, alice.id)).toBeUndefined();
  });
});

describe('clearStickyTag', () => {
  it('clears it, and a second clear is harmless', () => {
    setStickyTag({ db }, alice, 'отпуск');

    clearStickyTag({ db }, alice);
    clearStickyTag({ db }, alice);

    expect(currentStickyTag({ db }, alice)).toMatchObject({ name: undefined });
  });
});

describe('in a sealed ledger (ADR-0020)', () => {
  it('holds the tag in memory only, so a new process records without it', async () => {
    const keys = createLedgerKeyring(() => NOW);
    const deps = {
      db,
      keys,
      logger: createLogger('silent'),
      newId: () => randomUUID(),
      defaultTimezone: 'Europe/Belgrade',
    };
    await sealPersonalLedger(deps, alice, NOW);

    expect(setStickyTag(deps, alice, 'отпуск')).toMatchObject({ kind: 'set', sealed: true });
    expect(db.prepare('SELECT sticky_tag FROM ledger_members').pluck().all()).toEqual([null]);
    const record = (d: typeof deps, key: string) =>
      recordExpense(d, {
        user: alice,
        text: '300 такси',
        sourceKey: key,
        occurredAt: NOW,
        now: NOW,
      });
    expect(record(deps, 'tg:1001:1')).toMatchObject({ expense: { tags: ['отпуск'] } });

    // A restarted bot: the same database, a new keyring.
    const restarted = { ...deps, keys: createLedgerKeyring(() => NOW) };
    expect(record(restarted, 'tg:1001:2')).toMatchObject({ expense: { tags: [] } });
  });
});

describe('withStickyTag', () => {
  const tags = (...names: string[]) => names as TagName[];

  it('puts the text tags first, then the sticky tag once', () => {
    expect(withStickyTag(tags('рим'), 'отпуск' as TagName)).toEqual(['рим', 'отпуск']);
    expect(withStickyTag(tags('отпуск'), 'отпуск' as TagName)).toEqual(['отпуск']);
    expect(withStickyTag(tags('рим'), undefined)).toEqual(['рим']);
  });
});
