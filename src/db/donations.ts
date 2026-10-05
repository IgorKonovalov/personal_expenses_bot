import type { Db } from './connection.js';
import type { UserId } from './users.js';

export type DonationId = string & { readonly __brand: 'DonationId' };

export interface NewDonation {
  readonly id: DonationId;
  readonly userId: UserId;
  readonly stars: number;
  readonly chargeId: string;
  readonly createdAt: Date;
}

// Returns false when a row with this charge id already exists: nothing is written.
export function insertDonationIfNew(db: Db, donation: NewDonation): boolean {
  return (
    db
      .prepare<[string, string, number, string, string]>(
        `INSERT INTO donations (id, user_id, stars, telegram_payment_charge_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (telegram_payment_charge_id) DO NOTHING`,
      )
      .run(
        donation.id,
        donation.userId,
        donation.stars,
        donation.chargeId,
        donation.createdAt.toISOString(),
      ).changes > 0
  );
}
