import { Api } from 'grammy';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { decodeMeUrl } from '../domain/receipts/meUrl.js';
import { createLogger } from '../logger.js';
import type { FetchOutcome, ReceiptFetcher } from '../services/fetchDueReceipt.js';
import { provisionUser } from '../services/provisionUser.js';
import { recordReceipt } from '../services/recordReceipt.js';
import { startReceiptWorker, type ReceiptWorkerDeps } from './receiptWorker.js';
import { createLedgerKeyring } from '../services/ledgerKeys.js';

const T0 = new Date('2026-10-01T08:00:00Z');
const ME_LINK =
  'https://mapr.tax.gov.me/ic/#/verify?iic=abcdef0123456789abcdef0123456789&tin=02000000&crtd=2026-09-30T23:15:00+02:00&prc=42.50&bu=ab123cd456';

describe('startReceiptWorker', () => {
  it('fetches a receipt once when kicked twice while its fetch is in flight', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, T0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetcherCalls = 0;
    const fetcher: ReceiptFetcher = async (): Promise<FetchOutcome> => {
      fetcherCalls++;
      await gate;
      return {
        kind: 'fetched',
        receipt: { sellerName: 'Test Market', totalMinor: 4250, items: [] },
      };
    };
    let n = 0;
    const deps: ReceiptWorkerDeps = {
      db,
      logger: createLogger('silent'),
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => T0,
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'EUR',
      keys: createLedgerKeyring(() => T0),
      fetchers: { RS: fetcher, ME: fetcher },
    };
    const user = provisionUser(deps, {
      provider: 'telegram',
      externalId: '1001',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'EUR',
      now: T0,
    }).user;
    const decoded = decodeMeUrl(ME_LINK);
    if (decoded.kind !== 'receipt') throw new Error('synthetic receipt did not decode');
    recordReceipt(deps, {
      user,
      receipt: decoded.receipt,
      placeholder: 'Чек',
      occurredAt: T0,
      now: T0,
    });

    // Starting the worker kicks a drain, whose fetch now waits on the gate.
    const worker = startReceiptWorker(deps, new Api('0:test'));
    expect(fetcherCalls).toBe(1);
    worker.kick();
    worker.kick();
    release();
    await worker.stop();

    expect(fetcherCalls).toBe(1);
    expect(db.prepare('SELECT fetch_state FROM receipts').pluck().get()).toBe('fetched');
  });
});
