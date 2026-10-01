import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from '../db/expenses.js';
import type { FxList } from '../db/fxRates.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertUser, type UserId } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { fetchRates, type RateListFetcher } from './fetchRates.js';

// 10:00 in Belgrade.
const SEPT_28 = new Date('2026-09-28T08:00:00Z');
const SEPT_29 = new Date('2026-09-29T08:00:00Z');
const d = (day: string) => day as LocalDate;

const list = (listDate: string, listNumber: number): FxList => ({
  listDate: d(listDate),
  listNumber,
  rates: [{ currency: 'EUR', unit: 1, middleE4: 1174993 }],
});

let db: Db;
let asked: LocalDate[];

// The 26th and 27th are a weekend: NBS answers them with the 25th's list.
const fake: RateListFetcher = (day) => {
  asked.push(day);
  const weekend = day === '2026-09-26' || day === '2026-09-27';
  return Promise.resolve({
    kind: 'fetched',
    list: weekend ? list('2026-09-25', 183) : list(day, day === '2026-09-28' ? 184 : 185),
  });
};

function tick(now: Date, fetchList: RateListFetcher = fake) {
  return fetchRates(
    { db, logger: createLogger('silent'), fetchList },
    { now, signal: new AbortController().signal },
  );
}

function fxDays() {
  return db.prepare('SELECT day, list_date FROM fx_days ORDER BY day').all();
}

beforeEach(() => {
  asked = [];
  db = openDatabase(':memory:');
  runMigrations(db, SEPT_28);
  const user = 'user-a' as UserId;
  const ledger = 'ledger-a' as LedgerId;
  insertUser(db, { id: user, timezone: 'Europe/Belgrade', createdAt: SEPT_28 });
  insertLedger(db, {
    id: ledger,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RSD',
    ownerUserId: user,
    createdAt: SEPT_28,
  });
  insertMember(db, { ledgerId: ledger, userId: user, role: 'owner' });
  insertExpenseOrGetExisting(db, {
    id: 'expense-1' as ExpenseId,
    ledgerId: ledger,
    createdBy: user,
    amountMinor: 600,
    currency: 'USD',
    description: 'подписка',
    occurredAt: SEPT_28,
    occurredOn: d('2026-09-26'),
    sourceKey: 'test:1',
    createdAt: SEPT_28,
  });
});

describe('fetchRates', () => {
  it('fetches every day from the earliest expense through today, each mapped to its list', async () => {
    expect(await tick(SEPT_28)).toEqual({ fetched: 3, failed: 0 });
    expect(asked).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    expect(fxDays()).toEqual([
      { day: '2026-09-26', list_date: '2026-09-25' },
      { day: '2026-09-27', list_date: '2026-09-25' },
      { day: '2026-09-28', list_date: '2026-09-28' },
    ]);
  });

  it('refetches only today on a second tick the same day', async () => {
    await tick(SEPT_28);
    asked = [];
    await tick(new Date('2026-09-28T20:00:00Z'));
    expect(asked).toEqual(['2026-09-28']);
  });

  it('refetches yesterday once on the next day, and fetches the new day', async () => {
    await tick(SEPT_28);
    asked = [];
    await tick(SEPT_29);
    expect(asked).toEqual(['2026-09-28', '2026-09-29']);
    asked = [];
    await tick(new Date('2026-09-29T09:00:00Z'));
    expect(asked).toEqual(['2026-09-29']);
  });

  it('logs a failed day, stores nothing for it and moves on', async () => {
    const failing: RateListFetcher = (day, signal) =>
      day === '2026-09-27'
        ? Promise.resolve({ kind: 'failed', reason: 'unparseable' })
        : fake(day, signal);
    expect(await tick(SEPT_28, failing)).toEqual({ fetched: 2, failed: 1 });
    expect(fxDays().map((row) => (row as { day: string }).day)).toEqual([
      '2026-09-26',
      '2026-09-28',
    ]);
  });
});
