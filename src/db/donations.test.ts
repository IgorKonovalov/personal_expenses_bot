import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import { insertDonationIfNew, type DonationId } from './donations.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const USER = 'user-a' as UserId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
});

describe('donations repository', () => {
  it('inserts once per charge id', () => {
    const donation = {
      id: 'd1' as DonationId,
      userId: USER,
      stars: 150,
      chargeId: 'charge-1',
      createdAt: NOW,
    };

    expect(insertDonationIfNew(db, donation)).toBe(true);
    expect(insertDonationIfNew(db, { ...donation, id: 'd2' as DonationId })).toBe(false);

    expect(db.prepare('SELECT * FROM donations').all()).toEqual([
      {
        id: 'd1',
        user_id: USER,
        stars: 150,
        telegram_payment_charge_id: 'charge-1',
        created_at: '2026-10-01T08:00:00.000Z',
        refunded_at: null,
      },
    ]);
  });

  it('refuses a non-positive amount', () => {
    expect(() =>
      insertDonationIfNew(db, {
        id: 'd1' as DonationId,
        userId: USER,
        stars: 0,
        chargeId: 'charge-1',
        createdAt: NOW,
      }),
    ).toThrow(/CHECK/);
  });
});
