import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';

export type UserId = string & { readonly __brand: 'UserId' };

export interface User {
  readonly id: UserId;
  readonly timezone: string;
  readonly activeLedgerId: LedgerId | null;
}

interface UserRow {
  id: string;
  timezone: string;
  active_ledger_id: string | null;
}

export function findUserByIdentity(db: Db, provider: string, externalId: string): User | undefined {
  const row = db
    .prepare<[string, string], UserRow>(
      `SELECT u.id, u.timezone, u.active_ledger_id
         FROM auth_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = ? AND i.external_id = ?`,
    )
    .get(provider, externalId);
  return row === undefined ? undefined : toUser(row);
}

export function insertUser(db: Db, user: { id: UserId; timezone: string; createdAt: Date }): void {
  db.prepare<[string, string, string]>(
    'INSERT INTO users (id, timezone, created_at) VALUES (?, ?, ?)',
  ).run(user.id, user.timezone, user.createdAt.toISOString());
}

export function insertIdentity(
  db: Db,
  identity: { provider: string; externalId: string; userId: UserId },
): void {
  db.prepare<[string, string, string]>(
    'INSERT INTO auth_identities (provider, external_id, user_id) VALUES (?, ?, ?)',
  ).run(identity.provider, identity.externalId, identity.userId);
}

export function setActiveLedger(db: Db, userId: UserId, ledgerId: LedgerId): void {
  db.prepare<[string, string]>('UPDATE users SET active_ledger_id = ? WHERE id = ?').run(
    ledgerId,
    userId,
  );
}

// Returns false when the user already has this timezone: nothing is written.
export function updateUserTimezone(db: Db, userId: UserId, timezone: string): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        'UPDATE users SET timezone = ? WHERE id = ? AND timezone <> ?',
      )
      .run(timezone, userId, timezone).changes > 0
  );
}

function toUser(row: UserRow): User {
  return {
    id: row.id as UserId,
    timezone: row.timezone,
    activeLedgerId: row.active_ledger_id as LedgerId | null,
  };
}
