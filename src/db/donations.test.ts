import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection.js';
import {
  findDonationByChargeId,
  insertDonationIfNew,
  listDonationsOfUser,
  markDonationRefunded,
  type DonationId,
} from './donations.js';
import { runMigrations } from './migrate.js';
import { insertIdentity, insertUser, type UserId } from './users.js';

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

  it('lists a user’s donations newest first, capped at the limit', () => {
    for (const [i, day] of ['01', '03', '02'].entries()) {
      insertDonationIfNew(db, {
        id: `d${String(i)}` as DonationId,
        userId: USER,
        stars: 50,
        chargeId: `charge-${day}`,
        createdAt: new Date(`2026-10-${day}T08:00:00Z`),
      });
    }

    expect(listDonationsOfUser(db, USER, 2).map((d) => d.chargeId)).toEqual([
      'charge-03',
      'charge-02',
    ]);
    expect(listDonationsOfUser(db, 'user-b' as UserId, 10)).toEqual([]);
  });

  it('finds a donation with its payer’s Telegram id and marks it refunded once', () => {
    insertIdentity(db, { provider: 'telegram', externalId: '1001', userId: USER });
    insertDonationIfNew(db, {
      id: 'd1' as DonationId,
      userId: USER,
      stars: 150,
      chargeId: 'charge-1',
      createdAt: NOW,
    });
    const later = new Date('2026-10-02T09:00:00Z');

    expect(findDonationByChargeId(db, 'charge-1')).toEqual({
      chargeId: 'charge-1',
      stars: 150,
      createdAt: NOW,
      refundedAt: null,
      payerTelegramId: 1001,
    });
    expect(findDonationByChargeId(db, 'charge-x')).toBeUndefined();

    expect(markDonationRefunded(db, 'charge-1', later)).toBe(true);
    expect(markDonationRefunded(db, 'charge-1', new Date('2026-10-03T00:00:00Z'))).toBe(false);
    expect(findDonationByChargeId(db, 'charge-1')?.refundedAt).toEqual(later);
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
