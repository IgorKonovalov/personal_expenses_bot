import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { provisionUser } from './provisionUser.js';
import { recordDonation } from './recordDonation.js';
import { refundDonation } from './refundDonation.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const LATER = new Date('2026-10-02T09:00:00Z');

let db: Db;
let n: number;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  n = 0;
  provisionUser(
    { db, newId },
    {
      provider: 'telegram',
      externalId: '1003',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    },
  );
  recordDonation(
    { db, newId },
    { telegramUserId: 1003, stars: 150, chargeId: 'charge-1', now: NOW },
  );
});

function refundedAt(): unknown {
  return db
    .prepare("SELECT refunded_at FROM donations WHERE telegram_payment_charge_id = 'charge-1'")
    .pluck()
    .get();
}

describe('refundDonation', () => {
  it('refunds to the payer once, then answers already-refunded without calling Telegram', async () => {
    const refunds: [number, string][] = [];
    const deps = {
      db,
      now: () => LATER,
      refundStars: (payer: number, chargeId: string) => {
        refunds.push([payer, chargeId]);
        return Promise.resolve();
      },
    };

    expect(await refundDonation(deps, 'charge-1')).toEqual({ kind: 'refunded', stars: 150 });
    expect(await refundDonation(deps, 'charge-1')).toEqual({ kind: 'alreadyRefunded' });

    expect(refunds).toEqual([[1003, 'charge-1']]);
    expect(refundedAt()).toBe('2026-10-02T09:00:00.000Z');
  });

  it('leaves refunded_at NULL and reports the reason when Telegram refuses', async () => {
    const result = await refundDonation(
      {
        db,
        now: () => LATER,
        refundStars: () => Promise.reject(new Error('Bad Request: CHARGE_ALREADY_REFUNDED')),
      },
      'charge-1',
    );

    expect(result).toEqual({ kind: 'failed', reason: 'Bad Request: CHARGE_ALREADY_REFUNDED' });
    expect(refundedAt()).toBeNull();
  });

  it('answers not-found for an unknown charge id without calling Telegram', async () => {
    let called = false;
    const result = await refundDonation(
      {
        db,
        now: () => LATER,
        refundStars: () => {
          called = true;
          return Promise.resolve();
        },
      },
      'charge-x',
    );

    expect(result).toEqual({ kind: 'notFound' });
    expect(called).toBe(false);
  });
});
