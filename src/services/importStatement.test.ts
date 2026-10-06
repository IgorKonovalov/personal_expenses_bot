import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { parseRaiffeisenRs } from '../domain/statements/raiffeisenRs.js';
import {
  statementLines,
  TWO_PAGE_ROWS,
  type StatementRowFixture,
} from '../domain/statements/testing/raiffeisenStatement.js';
import type { StatementPurchase } from '../domain/statements/types.js';
import { createLogger } from '../logger.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { previewStatement, recordStatement } from './importStatement.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';

const NOW = new Date('2026-10-02T09:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let logLines: string[];
let alice: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(() => NOW),
  };
  alice = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
});

function purchasesOf(rows: readonly StatementRowFixture[]): readonly StatementPurchase[] {
  const parsed = parseRaiffeisenRs(statementLines(rows, { rowsPerPage: 6 }));
  if (parsed.kind !== 'statement') throw new Error('synthetic statement did not parse');
  return parsed.purchases;
}

function preview(rows: readonly StatementRowFixture[] = TWO_PAGE_ROWS, now = NOW) {
  const parsed = parseRaiffeisenRs(statementLines(rows, { rowsPerPage: 6 }));
  if (parsed.kind !== 'statement') throw new Error('synthetic statement did not parse');
  return previewStatement(deps, { user: alice, ...parsed, now });
}

function stored() {
  return db
    .prepare(
      'SELECT amount_minor, currency, occurred_on, occurred_at, description FROM expenses ORDER BY rowid',
    )
    .all();
}

describe('recordStatement', () => {
  it('records each card purchase with its transaction date and original amount', () => {
    const purchases = purchasesOf(TWO_PAGE_ROWS);
    expect(purchases).toHaveLength(6);
    preview();

    const result = recordStatement(deps, { user: alice, now: NOW });

    expect(result).toMatchObject({
      kind: 'recorded',
      count: 6,
      totals: [
        { amountMinor: 45000 + 123456 + 200000 + 45000, currency: 'RSD' },
        { amountMinor: 1500, currency: 'USD' },
        { amountMinor: 30, currency: 'EUR' },
      ],
    });
    expect(stored()).toEqual(
      purchases.map((p) => ({
        amount_minor: p.amountMinor,
        currency: p.currency,
        occurred_on: p.date,
        // Noon in Belgrade, CEST in September.
        occurred_at: `${p.date}T10:00:00.000Z`,
        description: p.merchant,
      })),
    );
    expect(stored()).toContainEqual(
      expect.objectContaining({ amount_minor: 1500, currency: 'USD', occurred_on: '2026-09-07' }),
    );
  });

  it('keys each row by its fingerprint and the ledger', () => {
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    const keys = db.prepare('SELECT source_key FROM expenses').pluck().all() as string[];
    expect(new Set(keys).size).toBe(6);
    for (const key of keys) expect(key).toMatch(/^stmt:raiffeisen-rs:[0-9a-f]{64}:[0-9a-f-]{36}$/);
  });

  it('records nothing on a second tap, and answers it as expired', () => {
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    expect(recordStatement(deps, { user: alice, now: NOW })).toEqual({ kind: 'expired' });
    expect(stored()).toHaveLength(6);
  });

  it('answers a tap after the TTL as expired and records nothing', () => {
    preview();

    const later = new Date(NOW.getTime() + 11 * 60 * 1000);

    expect(recordStatement(deps, { user: alice, now: later })).toEqual({ kind: 'expired' });
    expect(stored()).toEqual([]);
  });

  it('logs counts only: no merchant, amount or account', () => {
    preview();
    recordStatement(deps, { user: alice, now: NOW });

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      // The account number holds 13 zeros in a row; the test ids hold at most 12.
      expect(line).not.toMatch(/PRIMER|EXAMPLE|\b45000\b|\b1500\b|0{13}/);
    }
  });
});
