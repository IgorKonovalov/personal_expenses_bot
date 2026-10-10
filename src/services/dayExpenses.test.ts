import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { activeDayExpenses, type DayExpenses } from './dayExpenses.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, undoExpense, type RecordDeps } from './recordExpense.js';

// 12:00 local (CEST, UTC+2) on 2026-10-08.
const NOW = new Date('2026-10-08T10:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let messageId: number;

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
  messageId = 0;
});

function record(text: string, sentAt: string) {
  const result = recordExpense(deps, {
    user,
    text,
    sourceKey: `tg:1001:${++messageId}`,
    occurredAt: new Date(sentAt),
    now: NOW,
  });
  if (result.kind !== 'recorded') throw new Error(`setup: ${text} was ${result.kind}`);
  return result.expense;
}

function day(date: string): DayExpenses | undefined {
  const read = activeDayExpenses(deps, { user, date: date as LocalDate, now: NOW });
  if (isLocked(read)) throw new Error('a plaintext ledger read as locked');
  return read;
}

describe('dayExpenses', () => {
  it('files 00:30 local on the 8th under the 8th, not the 7th, in Belgrade', () => {
    record('450 кофе', '2026-10-07T22:30:00Z');

    expect(day('2026-10-08')?.expenses.map((e) => e.description)).toEqual(['кофе']);
    expect(day('2026-10-07')?.expenses).toEqual([]);
  });

  it('lists newest first without deleted expenses, under the totals per currency', () => {
    record('450 кофе', '2026-10-08T06:00:00Z');
    record('12.50 EUR такси', '2026-10-08T07:00:00Z');
    const undone = record('50 ошибка', '2026-10-08T08:00:00Z');
    record('1200 обед', '2026-10-08T09:00:00Z');
    expect(undoExpense(deps, { user, expenseId: undone.id, now: NOW }).kind).toBe('undone');

    const read = day('2026-10-08');

    expect(read?.expenses.map((e) => [e.description, e.money])).toEqual([
      ['обед', { amountMinor: 120000, currency: 'RSD' }],
      ['такси', { amountMinor: 1250, currency: 'EUR' }],
      ['кофе', { amountMinor: 45000, currency: 'RSD' }],
    ]);
    // No EUR rate is stored, so EUR stays its own total.
    expect(read?.totals).toEqual([
      { currency: 'RSD', amountMinor: 165000 },
      { currency: 'EUR', amountMinor: 1250 },
    ]);
    expect(read?.today).toBe('2026-10-08');
  });

  it('refuses a date after the ledger’s today', () => {
    expect(day('2026-10-09')).toBeUndefined();
  });
});
