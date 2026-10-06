import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { provisionUser } from './provisionUser.js';
import { recordDonation } from './recordDonation.js';

const NOW = new Date('2026-10-01T08:00:00Z');

let db: Db;
let n: number;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  n = 0;
});

function donationRows(): unknown[] {
  return db.prepare('SELECT user_id, stars, telegram_payment_charge_id FROM donations').all();
}

describe('recordDonation', () => {
  it('records a payment once, against the payer, and reports a repeat as a duplicate', () => {
    const { user } = provisionUser(
      { db, newId },
      {
        provider: 'telegram',
        externalId: '1001',
        defaultTimezone: 'Europe/Belgrade',
        defaultCurrency: 'RSD',
        now: NOW,
      },
    );
    const input = { telegramUserId: 1001, stars: 150, chargeId: 'charge-1', now: NOW };

    expect(recordDonation({ db, newId }, input)).toEqual({ kind: 'recorded', userId: user.id });
    expect(recordDonation({ db, newId }, input)).toEqual({ kind: 'duplicate' });

    expect(donationRows()).toEqual([
      { user_id: user.id, stars: 150, telegram_payment_charge_id: 'charge-1' },
    ]);
  });

  it('writes nothing for a payer with no internal user', () => {
    expect(
      recordDonation(
        { db, newId },
        { telegramUserId: 7777, stars: 50, chargeId: 'charge-2', now: NOW },
      ),
    ).toEqual({ kind: 'unknownPayer' });
    expect(donationRows()).toEqual([]);
  });
});
