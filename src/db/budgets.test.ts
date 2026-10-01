import { beforeEach, describe, expect, it } from 'vitest';
import { findLedgerBudget, setBudgetLimit } from './budgets.js';
import { openDatabase, type Db } from './connection.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T09:00:00Z');
const USER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Moscow', createdAt: NOW });
  insertLedger(db, {
    id: LEDGER,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RUB',
    ownerUserId: USER,
    createdAt: NOW,
  });
  insertMember(db, { ledgerId: LEDGER, userId: USER, role: 'owner' });
});

describe('ledger budgets', () => {
  it('creates the budget on the first limit with start day 1 and scope all', () => {
    expect(findLedgerBudget(db, LEDGER)).toBeUndefined();
    expect(setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'RUB' }, NOW)).toBe(true);
    expect(findLedgerBudget(db, LEDGER)).toEqual({
      ledgerId: LEDGER,
      limitMinor: 3_000_000,
      currency: 'RUB',
      scope: 'all',
      periodStartDay: 1,
    });
  });

  it('writes nothing for the same limit again, and adopts a new currency with a new limit', () => {
    setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'RUB' }, NOW);
    expect(setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'RUB' }, NOW)).toBe(false);
    expect(setBudgetLimit(db, LEDGER, { limitMinor: 3_000_000, currency: 'EUR' }, NOW)).toBe(true);
    expect(findLedgerBudget(db, LEDGER)?.currency).toBe('EUR');
  });

  it('refuses a limit that is not positive', () => {
    expect(() => setBudgetLimit(db, LEDGER, { limitMinor: 0, currency: 'RUB' }, NOW)).toThrow();
  });
});
