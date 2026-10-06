import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { insertLedger, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { claimSummaryPush, deleteLedgerSummaryPushes, findSummaryPush } from './summaryPushes.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T07:00:00Z');
const USER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertLedger(db, {
    id: LEDGER,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RSD',
    ownerUserId: USER,
    createdAt: NOW,
  });
});

const push = (periodKey: string, outcome: 'sent' | 'empty' = 'sent') => ({
  ledgerId: LEDGER,
  kind: 'period' as const,
  periodKey,
  outcome,
  createdAt: NOW,
});

describe('summary push claims', () => {
  it('claims a (ledger, kind, period key) once, keeping the first outcome', () => {
    expect(claimSummaryPush(db, push('2026-09'))).toBe(true);
    expect(claimSummaryPush(db, push('2026-09', 'empty'))).toBe(false);

    expect(findSummaryPush(db, LEDGER, 'period', '2026-09')).toBe('sent');
  });

  it('keeps kinds and period keys apart', () => {
    claimSummaryPush(db, push('2026-09', 'empty'));

    expect(claimSummaryPush(db, { ...push('2026-09'), kind: 'week' })).toBe(true);
    expect(claimSummaryPush(db, push('2026-10'))).toBe(true);
    expect(findSummaryPush(db, LEDGER, 'period', '2026-09')).toBe('empty');
    expect(findSummaryPush(db, LEDGER, 'week', '2026-09')).toBe('sent');
    expect(findSummaryPush(db, LEDGER, 'period', '2026-08')).toBeUndefined();
  });

  it("deletes a ledger's claims", () => {
    claimSummaryPush(db, push('2026-08'));
    claimSummaryPush(db, push('2026-09'));

    expect(deleteLedgerSummaryPushes(db, LEDGER)).toBe(2);
    expect(findSummaryPush(db, LEDGER, 'period', '2026-09')).toBeUndefined();
  });
});
