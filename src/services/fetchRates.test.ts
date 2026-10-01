import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { insertExpenseOrGetExisting, softDeleteExpense, type ExpenseId } from '../db/expenses.js';
import type { FxList } from '../db/fxRates.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertUser, type UserId } from '../db/users.js';
import { addDays } from '../domain/dateText.js';
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

const user = 'user-a' as UserId;
const ledger = 'ledger-a' as LedgerId;
let expenses: number;

function expenseOn(day: string): ExpenseId {
  expenses++;
  const id = `expense-${expenses}` as ExpenseId;
  insertExpenseOrGetExisting(db, {
    id,
    ledgerId: ledger,
    createdBy: user,
    amountMinor: 600,
    currency: 'USD',
    description: 'подписка',
    occurredAt: SEPT_28,
    occurredOn: d(day),
    sourceKey: `test:${expenses}`,
    createdAt: SEPT_28,
  });
  return id;
}

// `from`, then each day back through `to`.
function daysDown(from: string, to: string): LocalDate[] {
  const days: LocalDate[] = [];
  for (let day = d(from); day >= to; day = addDays(day, -1)) days.push(day);
  return days;
}

beforeEach(() => {
  asked = [];
  expenses = 0;
  db = openDatabase(':memory:');
  runMigrations(db, SEPT_28);
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
});

describe('fetchRates', () => {
  it('fetches today and the expense days, newest first, each mapped to its list', async () => {
    expenseOn('2026-09-26');
    expect(await tick(SEPT_28)).toEqual({ fetched: 2, failed: 0 });
    expect(asked).toEqual(['2026-09-28', '2026-09-26']);
    expect(fxDays()).toEqual([
      { day: '2026-09-26', list_date: '2026-09-25' },
      { day: '2026-09-28', list_date: '2026-09-28' },
    ]);
  });

  it('skips the days between expenses however far back the earliest is', async () => {
    expenseOn('2026-07-31');
    expenseOn('2026-09-28');
    await tick(new Date('2026-10-01T08:00:00Z'));
    expect(asked).toEqual(['2026-10-01', '2026-09-28', '2026-07-31']);
  });

  it('refetches a day only while its row was fetched on or before that day', async () => {
    expenseOn('2026-09-26');
    expenseOn('2026-09-28');
    await tick(SEPT_28);
    asked = [];
    await tick(new Date('2026-09-28T20:00:00Z'));
    expect(asked).toEqual(['2026-09-28']);
    asked = [];
    await tick(SEPT_29);
    expect(asked).toEqual(['2026-09-29', '2026-09-28']);
    asked = [];
    await tick(new Date('2026-09-29T09:00:00Z'));
    expect(asked).toEqual(['2026-09-29']);
  });

  it('fetches at most 31 days a tick, newest first, and the rest on the next', async () => {
    for (const day of daysDown('2026-09-28', '2026-08-20')) expenseOn(day);
    expect(await tick(SEPT_28)).toEqual({ fetched: 31, failed: 0 });
    expect(asked).toEqual(daysDown('2026-09-28', '2026-08-29'));
    asked = [];
    expect(await tick(new Date('2026-09-28T20:00:00Z'))).toEqual({ fetched: 10, failed: 0 });
    expect(asked).toEqual(['2026-09-28', ...daysDown('2026-08-28', '2026-08-20')]);
  });

  it("asks neither a deleted expense's day nor a day after Belgrade's today", async () => {
    softDeleteExpense(db, expenseOn('2026-09-26'), SEPT_28);
    expenseOn('2026-09-29');
    await tick(SEPT_28);
    expect(asked).toEqual(['2026-09-28']);
  });

  it('logs a failed day, stores nothing for it and moves on', async () => {
    expenseOn('2026-09-26');
    const failing: RateListFetcher = (day, signal) =>
      day === '2026-09-28'
        ? Promise.resolve({ kind: 'failed', reason: 'unparseable' })
        : fake(day, signal);
    expect(await tick(SEPT_28, failing)).toEqual({ fetched: 1, failed: 1 });
    expect(asked).toEqual(['2026-09-26']);
    expect(fxDays().map((row) => (row as { day: string }).day)).toEqual(['2026-09-26']);
  });
});
