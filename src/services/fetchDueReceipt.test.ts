import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryId } from '../db/categories.js';
import { openDatabase, type Db } from '../db/connection.js';
import { setExpenseCategory, setExpenseDescription, type ExpenseId } from '../db/expenses.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { decodeMeUrl } from '../domain/receipts/meUrl.js';
import type { FetchedReceipt } from '../domain/receipts/types.js';
import { createLogger } from '../logger.js';
import {
  fetchDueReceipt,
  type FetchDeps,
  type FetchOutcome,
  type ReceiptFetcher,
} from './fetchDueReceipt.js';
import { provisionUser } from './provisionUser.js';
import { recordReceipt } from './recordReceipt.js';

const T0 = new Date('2026-10-01T08:00:00Z');
const MINUTE = 60_000;
const ME_LINK =
  'https://mapr.tax.gov.me/ic/#/verify?iic=abcdef0123456789abcdef0123456789&tin=02000000&crtd=2026-09-30T23:15:00+02:00&prc=42.50&bu=ab123cd456';
const FETCHED: FetchedReceipt = {
  sellerName: 'Test Market',
  totalMinor: 4250,
  items: [
    { name: 'Hljeb', quantity: '2', totalMinor: 240 },
    { name: 'Sir', quantity: '0.535', totalMinor: 4010 },
  ],
};

let db: Db;
let logLines: string[];
let alice: User;
let expenseId: ExpenseId;
let fetcherCalls: number;
let outcome: () => Promise<FetchOutcome>;

function deps(): FetchDeps {
  const fetcher: ReceiptFetcher = () => {
    fetcherCalls++;
    return outcome();
  };
  let n = 100;
  return {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
    fetchers: { RS: fetcher, ME: fetcher },
    placeholder: 'Чек',
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, T0);
  logLines = [];
  fetcherCalls = 0;
  outcome = () => Promise.resolve({ kind: 'fetched', receipt: FETCHED });
  alice = provisionUser(deps(), {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: T0,
  }).user;
  const decoded = decodeMeUrl(ME_LINK);
  if (decoded.kind !== 'receipt') throw new Error('synthetic receipt did not decode');
  const recorded = recordReceipt(deps(), {
    user: alice,
    receipt: decoded.receipt,
    placeholder: 'Чек',
    occurredAt: T0,
    now: T0,
  });
  if (recorded.kind !== 'recorded') throw new Error('receipt not recorded');
  expenseId = recorded.expense.id;
});

function run(now = T0) {
  return fetchDueReceipt(deps(), { now, signal: new AbortController().signal });
}

function expenseRow(): unknown {
  return db
    .prepare(
      `SELECT e.amount_minor, e.description, e.description_key, c.name AS category
         FROM expenses e JOIN categories c ON c.id = e.category_id`,
    )
    .get();
}

function receiptRow(): unknown {
  return db.prepare('SELECT fetch_state, attempts, seller_name FROM receipts').get();
}

function categoryId(presetKey: string): CategoryId {
  return db
    .prepare<[string], CategoryId>('SELECT id FROM categories WHERE preset_key = ?')
    .pluck()
    .get(presetKey) as CategoryId;
}

describe('fetchDueReceipt', () => {
  it('stores the items in source order, the seller and fetched, and names the expense', async () => {
    const result = await run();

    expect(result.kind).toBe('settled');
    expect(
      db
        .prepare(
          'SELECT position, name, quantity, total_minor FROM receipt_items ORDER BY position',
        )
        .all(),
    ).toEqual([
      { position: 1, name: 'Hljeb', quantity: '2', total_minor: 240 },
      { position: 2, name: 'Sir', quantity: '0.535', total_minor: 4010 },
    ]);
    expect(receiptRow()).toEqual({
      fetch_state: 'fetched',
      attempts: 0,
      seller_name: 'Test Market',
    });
    expect(expenseRow()).toMatchObject({
      amount_minor: 4250,
      description: 'Test Market',
      description_key: 'test market',
    });
  });

  it('re-suggests a fallback category from the seller name', async () => {
    outcome = () =>
      Promise.resolve({ kind: 'fetched', receipt: { ...FETCHED, sellerName: 'Кафе Тест' } });

    await run();

    expect(expenseRow()).toMatchObject({ description: 'Кафе Тест', category: 'Кафе и рестораны' });
  });

  it('keeps every field of an expense whose category the user changed', async () => {
    setExpenseCategory(db, expenseId, categoryId('groceries'), new Date(T0.getTime() + 1000));
    outcome = () =>
      Promise.resolve({ kind: 'fetched', receipt: { ...FETCHED, sellerName: 'Кафе Тест' } });

    await run();

    expect(expenseRow()).toEqual({
      amount_minor: 4250,
      description: 'Чек',
      description_key: 'чек',
      category: 'Продукты',
    });
    expect(receiptRow()).toEqual({ fetch_state: 'fetched', attempts: 0, seller_name: 'Кафе Тест' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get()).toEqual({ n: 2 });
  });

  it('keeps every field of an expense whose description the user edited', async () => {
    setExpenseDescription(
      db,
      expenseId,
      { description: 'продукты на неделю', descriptionKey: 'продукты на неделю' },
      new Date(T0.getTime() + 1000),
    );
    outcome = () =>
      Promise.resolve({ kind: 'fetched', receipt: { ...FETCHED, sellerName: 'Кафе Тест' } });

    await run();

    expect(expenseRow()).toEqual({
      amount_minor: 4250,
      description: 'продукты на неделю',
      description_key: 'продукты на неделю',
      category: 'Другое',
    });
    expect(receiptRow()).toMatchObject({ fetch_state: 'fetched', seller_name: 'Кафе Тест' });
  });

  it('keeps the QR amount when the site total differs, and warns with the receipt id only', async () => {
    outcome = () => Promise.resolve({ kind: 'fetched', receipt: { ...FETCHED, totalMinor: 9999 } });

    await run();

    expect(expenseRow()).toMatchObject({ amount_minor: 4250 });
    const warns = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.level === 40);
    const receiptId = db.prepare('SELECT id FROM receipts').pluck().get();
    expect(warns).toHaveLength(1);
    expect(
      Object.keys(warns[0] ?? {}).filter(
        (k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k),
      ),
    ).toEqual(['receiptId']);
    expect(warns[0]).toMatchObject({ receiptId });
  });

  it('attempts a failing receipt at t0, +1, +6, +36 min, +2 h 36 min and +14 h 36 min, then gives up', async () => {
    outcome = () => Promise.resolve({ kind: 'failed', reason: 'http' });
    const attemptedAt: number[] = [];

    // A fake clock stepping a minute at a time through 16 hours.
    for (let minute = 0; minute <= 16 * 60; minute++) {
      const before = fetcherCalls;
      await run(new Date(T0.getTime() + minute * MINUTE));
      if (fetcherCalls > before) attemptedAt.push(minute);
    }

    expect(attemptedAt).toEqual([0, 1, 6, 36, 156, 876]);
    expect(receiptRow()).toEqual({ fetch_state: 'failed', attempts: 6, seller_name: null });
    expect(fetcherCalls).toBe(6);
  });

  it('inserts the items once when the same receipt is fetched twice at once (a restart mid-fetch)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    outcome = async () => {
      await gate;
      return { kind: 'fetched', receipt: FETCHED };
    };

    const first = run();
    const second = run();
    release();
    const results = await Promise.all([first, second]);

    expect(fetcherCalls).toBe(2);
    expect(results.map((r) => r.kind).sort()).toEqual(['pending', 'settled']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM receipt_items').get()).toEqual({ n: 2 });
  });

  it('logs ids and counts, never the seller, items or amounts', async () => {
    await run();

    for (const line of logLines) {
      expect(line).not.toContain('Test Market');
      expect(line).not.toContain('Hljeb');
      expect(line).not.toContain('4250');
    }
  });

  it('is idle when nothing is due', async () => {
    await run();

    expect(await run()).toEqual({ kind: 'idle' });
    expect(fetcherCalls).toBe(1);
  });
});
