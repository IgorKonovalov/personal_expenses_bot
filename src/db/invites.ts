import type { Db } from './connection.js';
import type { UserId } from './users.js';

// Invite codes and their redemptions (ADR-0024). Instants are stored as UTC ISO strings.

export interface InviteCode {
  readonly code: string;
  readonly maxUses: number;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

interface InviteCodeRow {
  code: string;
  max_uses: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export function insertInviteCode(db: Db, invite: Omit<InviteCode, 'revokedAt'>): void {
  db.prepare<[string, number, string, string]>(
    'INSERT INTO invite_codes (code, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(
    invite.code,
    invite.maxUses,
    invite.expiresAt.toISOString(),
    invite.createdAt.toISOString(),
  );
}

export function findInviteCode(db: Db, code: string): InviteCode | undefined {
  const row = db
    .prepare<[string], InviteCodeRow>(
      'SELECT code, max_uses, expires_at, revoked_at, created_at FROM invite_codes WHERE code = ?',
    )
    .get(code);
  return row === undefined ? undefined : toInviteCode(row);
}

export function countRedemptions(db: Db, code: string): number {
  return (
    db
      .prepare<[string], number>('SELECT COUNT(*) FROM invite_redemptions WHERE code = ?')
      .pluck()
      .get(code) ?? 0
  );
}

// Returns false when this user already redeemed this code: nothing is written.
export function insertRedemption(
  db: Db,
  redemption: { code: string; userId: UserId; redeemedAt: Date },
): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        `INSERT INTO invite_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)
         ON CONFLICT (code, user_id) DO NOTHING`,
      )
      .run(redemption.code, redemption.userId, redemption.redeemedAt.toISOString()).changes > 0
  );
}

// Codes not revoked and not expired at `now`, oldest first, with how many times each was used.
export function listLiveInviteCodes(db: Db, now: Date): (InviteCode & { readonly used: number })[] {
  return db
    .prepare<[string], InviteCodeRow & { used: number }>(
      `SELECT c.code, c.max_uses, c.expires_at, c.revoked_at, c.created_at,
              (SELECT COUNT(*) FROM invite_redemptions r WHERE r.code = c.code) AS used
         FROM invite_codes c
        WHERE c.revoked_at IS NULL AND c.expires_at > ?
        ORDER BY c.created_at, c.code`,
    )
    .all(now.toISOString())
    .map((row) => ({ ...toInviteCode(row), used: row.used }));
}

export function countLiveInviteCodes(db: Db, now: Date): number {
  return (
    db
      .prepare<[string], number>(
        'SELECT COUNT(*) FROM invite_codes WHERE revoked_at IS NULL AND expires_at > ?',
      )
      .pluck()
      .get(now.toISOString()) ?? 0
  );
}

// Sets `revoked_at` unless it is already set. Returns false when nothing was written.
export function revokeInviteCode(db: Db, code: string, at: Date): boolean {
  return (
    db
      .prepare<[string, string]>(
        'UPDATE invite_codes SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL',
      )
      .run(at.toISOString(), code).changes > 0
  );
}

function toInviteCode(row: InviteCodeRow): InviteCode {
  return {
    code: row.code,
    maxUses: row.max_uses,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    createdAt: new Date(row.created_at),
  };
}
