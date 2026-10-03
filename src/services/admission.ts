import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';
import {
  countRedemptions,
  findInviteCode,
  insertInviteCode,
  insertRedemption,
  type InviteCode,
} from '../db/invites.js';
import { admitUser, findAdmissionByIdentity, type User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { provisionUser, type ServiceDeps } from './provisionUser.js';

// Who may use the bot in private (ADR-0024). Admission is `users.admitted_at`, set by redeeming
// an invite code or by the boot-time admit list; `blocked_at` overrides it. The admin is always
// admitted. Every check reads the database, so a change applies to the next update.

export interface AccessDeps {
  readonly db: Db;
  readonly adminTelegramId: number;
}

export interface AdmissionDeps extends ServiceDeps, AccessDeps {
  readonly defaultTimezone: string;
  readonly defaultCurrency: CurrencyCode;
}

export type Access = 'admitted' | 'blocked' | 'stranger';

export function accessOf({ db, adminTelegramId }: AccessDeps, telegramId: number): Access {
  if (telegramId === adminTelegramId) return 'admitted';
  const admission = findAdmissionByIdentity(db, 'telegram', String(telegramId));
  if (admission === undefined) return 'stranger';
  if (admission.blockedAt !== null) return 'blocked';
  return admission.admittedAt === null ? 'stranger' : 'admitted';
}

// The one access check: the private chat, group activation and the group card's DM link.
export function isAdmitted(deps: AccessDeps, telegramId: number): boolean {
  return accessOf(deps, telegramId) === 'admitted';
}

function provision(deps: AdmissionDeps, telegramId: number, now: Date): User {
  return provisionUser(deps, {
    provider: 'telegram',
    externalId: String(telegramId),
    defaultTimezone: deps.defaultTimezone,
    defaultCurrency: deps.defaultCurrency,
    now,
  }).user;
}

// Provisions and admits each id: at boot, the admin and ADMIT_TELEGRAM_IDS. An id already
// admitted keeps its `admitted_at`, so a second boot writes nothing. Returns how many were newly
// admitted.
export function admitTelegramIds(deps: AdmissionDeps, ids: Iterable<number>, now: Date): number {
  return deps.db.transaction(() => {
    let admitted = 0;
    for (const id of new Set(ids)) {
      if (admitUser(deps.db, provision(deps, id, now).id, now)) admitted += 1;
    }
    return admitted;
  })();
}

export const INVITE_DEFAULTS = { maxUses: 10, days: 14 } as const;
export const INVITE_LIMITS = { min: 1, max: 1000 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// A new code: 8 random bytes as 11 base64url characters, valid until `now + days`.
export function createInvite(
  { db }: Pick<AccessDeps, 'db'>,
  input: { readonly maxUses: number; readonly days: number; readonly now: Date },
): InviteCode {
  const invite: InviteCode = {
    code: randomBytes(8).toString('base64url'),
    maxUses: input.maxUses,
    expiresAt: new Date(input.now.getTime() + input.days * DAY_MS),
    revokedAt: null,
    createdAt: input.now,
  };
  insertInviteCode(db, invite);
  return invite;
}

export type RedeemResult =
  | { readonly kind: 'admitted'; readonly user: User }
  // Unknown, revoked, expired or used up: nothing is written.
  | { readonly kind: 'invalid' };

// One transaction: the code is live (`now < expires_at`, not revoked, redemptions below
// `max_uses`), then the sender is provisioned, admitted and the redemption recorded.
export function redeemInvite(
  deps: AdmissionDeps,
  input: { readonly code: string; readonly telegramId: number; readonly now: Date },
): RedeemResult {
  const { db } = deps;
  const { now } = input;
  return db.transaction((): RedeemResult => {
    const invite = findInviteCode(db, input.code);
    if (
      invite === undefined ||
      invite.revokedAt !== null ||
      now.getTime() >= invite.expiresAt.getTime() ||
      countRedemptions(db, invite.code) >= invite.maxUses
    ) {
      return { kind: 'invalid' };
    }
    const user = provision(deps, input.telegramId, now);
    admitUser(db, user.id, now);
    insertRedemption(db, { code: invite.code, userId: user.id, redeemedAt: now });
    return { kind: 'admitted', user };
  })();
}
