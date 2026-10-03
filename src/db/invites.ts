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

function toInviteCode(row: InviteCodeRow): InviteCode {
  return {
    code: row.code,
    maxUses: row.max_uses,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    createdAt: new Date(row.created_at),
  };
}
