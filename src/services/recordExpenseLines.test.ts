import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import { recordExpenseLines } from './recordExpenseLines.js';
import { sealPersonalLedger } from './testing/sealLedger.js';

// 12:00 local (CEST, UTC+2) on 2026-10-08.
const NOW = new Date('2026-10-08T10:00:00Z');
const KEY = 'tg:1001:7';

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => NOW),
  };
  user = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
});

const record = (text: string) =>
  recordExpenseLines(deps, { user, text, sourceKey: KEY, occurredAt: NOW, now: NOW });

const rows = () =>
  db
    .prepare(
      'SELECT source_key, amount_minor, currency, description, occurred_on FROM expenses ORDER BY source_key',
    )
    .all();

describe('recordExpenseLines (ADR-0049)', () => {
  it('stores each line under its own key, dated by its own date word', () => {
    const result = record('450 кофе\n1200 такси вчера\n12 eur обед');

    expect(result).toMatchObject({ kind: 'recorded', duplicate: false, sentOn: '2026-10-08' });
    expect(rows()).toEqual([
      {
        source_key: KEY,
        amount_minor: 45000,
        currency: 'RSD',
        description: 'кофе',
        occurred_on: '2026-10-08',
      },
      {
        source_key: `${KEY}:2`,
        amount_minor: 120000,
        currency: 'RSD',
        description: 'такси',
        occurred_on: '2026-10-07',
      },
      {
        source_key: `${KEY}:3`,
        amount_minor: 1200,
        currency: 'EUR',
        description: 'обед',
        occurred_on: '2026-10-08',
      },
    ]);
  });

  it('returns the stored batch on a redelivery and records nothing more', () => {
    const first = record('450 кофе\n1200 такси');
    const again = record('450 кофе\n1200 такси');

    expect(again).toMatchObject({ kind: 'recorded', duplicate: true });
    expect(again.kind === 'recorded' && again.expenses.map((e) => e.id)).toEqual(
      first.kind === 'recorded' && first.expenses.map((e) => e.id),
    );
    expect(rows()).toHaveLength(2);
  });

  it('records nothing for a bad line', () => {
    expect(record('450 кофе\n1.500 лампа')).toEqual({
      kind: 'badLine',
      n: 2,
      line: '1.500 лампа',
      reason: 'ambiguous',
    });
    expect(rows()).toEqual([]);
  });

  it('leaves a one-expense text to the single path', () => {
    expect(record('450 кофе\nс Ирой')).toEqual({ kind: 'single' });
    expect(rows()).toEqual([]);
  });

  it('records sealed rows into a locked sealed ledger, and answers its redelivery sealedDuplicate', async () => {
    const ledger = await sealPersonalLedger(deps, user, NOW);
    deps.keys.lock(ledger.id);

    expect(record('450 кофе\n1200 такси\n12 eur обед')).toMatchObject({
      kind: 'recorded',
      duplicate: false,
    });
    expect(db.prepare('SELECT COUNT(*) FROM expenses WHERE sealed IS NOT NULL').pluck().get()).toBe(
      3,
    );
    expect(record('450 кофе\n1200 такси\n12 eur обед')).toEqual({ kind: 'sealedDuplicate' });
  });
});
