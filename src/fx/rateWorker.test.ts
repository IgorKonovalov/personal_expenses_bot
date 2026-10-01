import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from '../db/expenses.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import { insertUser, type UserId } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import type { RateListFetcher, RateListOutcome } from '../services/fetchRates.js';
import { startRateWorker } from './rateWorker.js';

const T0 = new Date('2026-09-28T08:00:00Z');

describe('startRateWorker', () => {
  it('fetches a day once when kicked twice while its tick is in flight, and stops cleanly', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, T0);
    const user = 'user-a' as UserId;
    const ledger = 'ledger-a' as LedgerId;
    insertUser(db, { id: user, timezone: 'Europe/Belgrade', createdAt: T0 });
    insertLedger(db, {
      id: ledger,
      kind: 'personal',
      name: 'Personal',
      defaultCurrency: 'RSD',
      ownerUserId: user,
      createdAt: T0,
    });
    insertMember(db, { ledgerId: ledger, userId: user, role: 'owner' });
    insertExpenseOrGetExisting(db, {
      id: 'expense-1' as ExpenseId,
      ledgerId: ledger,
      createdBy: user,
      amountMinor: 600,
      currency: 'USD',
      description: 'подписка',
      occurredAt: T0,
      occurredOn: '2026-09-28' as LocalDate,
      sourceKey: 'test:1',
      createdAt: T0,
    });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fetchList: RateListFetcher = async (day): Promise<RateListOutcome> => {
      calls++;
      await gate;
      return { kind: 'fetched', list: { listDate: day, listNumber: 184, rates: [] } };
    };

    // Starting the worker runs a tick, whose fetch now waits on the gate.
    const worker = startRateWorker({
      db,
      logger: createLogger('silent'),
      fetchList,
      now: () => T0,
    });
    expect(calls).toBe(1);
    worker.kick();
    worker.kick();
    release();
    await worker.stop();

    expect(calls).toBe(1);
    expect(db.prepare('SELECT day, list_date FROM fx_days').all()).toEqual([
      { day: '2026-09-28', list_date: '2026-09-28' },
    ]);
  });
});
