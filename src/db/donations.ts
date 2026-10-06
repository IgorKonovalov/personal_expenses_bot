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

export interface DonationSummary {
  readonly chargeId: string;
  readonly stars: number;
  readonly createdAt: Date;
  readonly refundedAt: Date | null;
}

// A donation with its payer's Telegram id, which a refund needs. Null when the payer has no
// Telegram identity left.
export interface RefundableDonation extends DonationSummary {
  readonly payerTelegramId: number | null;
}

interface SummaryRow {
  telegram_payment_charge_id: string;
  stars: number;
  created_at: string;
  refunded_at: string | null;
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

// The user's newest donations first, at most `limit`.
export function listDonationsOfUser(db: Db, userId: UserId, limit: number): DonationSummary[] {
  return db
    .prepare<[string, number], SummaryRow>(
      `SELECT telegram_payment_charge_id, stars, created_at, refunded_at
         FROM donations
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(userId, limit)
    .map(toSummary);
}

export function findDonationByChargeId(db: Db, chargeId: string): RefundableDonation | undefined {
  const row = db
    .prepare<[string], SummaryRow & { payer: string | null }>(
      `SELECT d.telegram_payment_charge_id, d.stars, d.created_at, d.refunded_at,
              (SELECT i.external_id FROM auth_identities i
                WHERE i.user_id = d.user_id AND i.provider = 'telegram'
                LIMIT 1) AS payer
         FROM donations d
        WHERE d.telegram_payment_charge_id = ?`,
    )
    .get(chargeId);
  if (row === undefined) return undefined;
  return { ...toSummary(row), payerTelegramId: row.payer === null ? null : Number(row.payer) };
}

// Returns false when the donation is already refunded or absent: nothing is written.
export function markDonationRefunded(db: Db, chargeId: string, at: Date): boolean {
  return (
    db
      .prepare<[string, string]>(
        `UPDATE donations SET refunded_at = ?
          WHERE telegram_payment_charge_id = ? AND refunded_at IS NULL`,
      )
      .run(at.toISOString(), chargeId).changes > 0
  );
}

function toSummary(row: SummaryRow): DonationSummary {
  return {
    chargeId: row.telegram_payment_charge_id,
    stars: row.stars,
    createdAt: new Date(row.created_at),
    refundedAt: row.refunded_at === null ? null : new Date(row.refunded_at),
  };
}
