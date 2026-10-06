import type { Db } from '../db/connection.js';
import { insertDonationIfNew, type DonationId } from '../db/donations.js';
import { findUserByIdentity, type UserId } from '../db/users.js';

export interface DonationInput {
  // The payer's Telegram user id.
  readonly telegramUserId: number;
  readonly stars: number;
  readonly chargeId: string;
  readonly now: Date;
}

export type RecordDonationResult =
  | { readonly kind: 'recorded'; readonly userId: UserId }
  // The same charge id was recorded before: a redelivered update.
  | { readonly kind: 'duplicate' }
  // No internal user behind the payer's Telegram identity: nothing is written.
  | { readonly kind: 'unknownPayer' };

// Records a completed Stars payment once per charge id. Access is not checked: the Stars are
// already taken by the time this runs.
export function recordDonation(
  { db, newId }: { readonly db: Db; readonly newId: () => string },
  input: DonationInput,
): RecordDonationResult {
  const user = findUserByIdentity(db, 'telegram', String(input.telegramUserId));
  if (user === undefined) return { kind: 'unknownPayer' };
  const inserted = insertDonationIfNew(db, {
    id: newId() as DonationId,
    userId: user.id,
    stars: input.stars,
    chargeId: input.chargeId,
    createdAt: input.now,
  });
  return inserted ? { kind: 'recorded', userId: user.id } : { kind: 'duplicate' };
}
