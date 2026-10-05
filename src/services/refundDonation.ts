import type { Db } from '../db/connection.js';
import { findDonationByChargeId, markDonationRefunded } from '../db/donations.js';

export interface RefundDeps {
  readonly db: Db;
  readonly now: () => Date;
  // Returns the Stars to the payer (Telegram's refundStarPayment). Rejects when Telegram refuses.
  readonly refundStars: (payerTelegramId: number, chargeId: string) => Promise<void>;
}

export type RefundResult =
  | { readonly kind: 'refunded'; readonly stars: number }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'alreadyRefunded' }
  // Telegram refused, or the payer has no Telegram identity: refunded_at stays NULL.
  | { readonly kind: 'failed'; readonly reason: string };

// Refunds a donation by its charge id. Telegram is called only for a donation not yet marked
// refunded, and refunded_at is set only after Telegram accepted.
export async function refundDonation(deps: RefundDeps, chargeId: string): Promise<RefundResult> {
  const donation = findDonationByChargeId(deps.db, chargeId);
  if (donation === undefined) return { kind: 'notFound' };
  if (donation.refundedAt !== null) return { kind: 'alreadyRefunded' };
  if (donation.payerTelegramId === null) {
    return { kind: 'failed', reason: 'payer has no Telegram identity' };
  }
  try {
    await deps.refundStars(donation.payerTelegramId, chargeId);
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : typeof error };
  }
  // A concurrent /refund of the same id may have marked it first; Telegram refuses the second
  // refundStarPayment anyway.
  markDonationRefunded(deps.db, chargeId, deps.now());
  return { kind: 'refunded', stars: donation.stars };
}
