import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { Db } from './connection.js';
import type { UserId } from './users.js';

export type LedgerId = string & { readonly __brand: 'LedgerId' };
export type LedgerKind = 'personal' | 'shared';

export interface Ledger {
  readonly id: LedgerId;
  readonly kind: LedgerKind;
  readonly name: string;
  readonly defaultCurrency: CurrencyCode;
  // An IANA zone for a shared ledger, null for a personal one (ADR-0015).
  readonly timezone: string | null;
}

interface LedgerRow {
  id: string;
  kind: LedgerKind;
  name: string;
  default_currency: string;
  timezone: string | null;
}

const COLUMNS = 'l.id, l.kind, l.name, l.default_currency, l.timezone';

export type NewLedger = Omit<Ledger, 'timezone'> & {
  readonly timezone?: string | null;
  readonly ownerUserId: UserId;
  readonly createdAt: Date;
};

// A shared ledger without a timezone throws: the schema can't hold that CHECK (ADR-0015).
export function insertLedger(db: Db, ledger: NewLedger): void {
  const timezone = ledger.timezone ?? null;
  if (ledger.kind === 'shared' && timezone === null) {
    throw new Error(`shared ledger ${ledger.id} needs a timezone`);
  }
  db.prepare<[string, string, string, string, string | null, string, string]>(
    `INSERT INTO ledgers (id, kind, name, default_currency, timezone, owner_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ledger.id,
    ledger.kind,
    ledger.name,
    ledger.defaultCurrency,
    timezone,
    ledger.ownerUserId,
    ledger.createdAt.toISOString(),
  );
}

export function insertMember(
  db: Db,
  member: { ledgerId: LedgerId; userId: UserId; role: LedgerRole; displayName?: string },
): void {
  db.prepare<[string, string, string, string | null]>(
    'INSERT INTO ledger_members (ledger_id, user_id, role, display_name) VALUES (?, ?, ?, ?)',
  ).run(member.ledgerId, member.userId, member.role, member.displayName ?? null);
}

// Adds the user as a `member`, or, for an existing member of any role, only refreshes the
// display name. Returns true when the membership is new.
export function joinMember(
  db: Db,
  member: { ledgerId: LedgerId; userId: UserId; displayName: string },
): boolean {
  const { changes } = db
    .prepare<[string, string, string]>(
      `INSERT INTO ledger_members (ledger_id, user_id, role, display_name)
       VALUES (?, ?, 'member', ?)
       ON CONFLICT (ledger_id, user_id) DO NOTHING`,
    )
    .run(member.ledgerId, member.userId, member.displayName);
  if (changes === 0) {
    db.prepare<[string, string, string, string]>(
      `UPDATE ledger_members SET display_name = ?
        WHERE ledger_id = ? AND user_id = ? AND display_name IS NOT ?`,
    ).run(member.displayName, member.ledgerId, member.userId, member.displayName);
  }
  return changes === 1;
}

// Each member's stored display name; null for one never seen in a group.
export function listMemberNames(db: Db, ledgerId: LedgerId): ReadonlyMap<UserId, string | null> {
  const rows = db
    .prepare<[string], { user_id: string; display_name: string | null }>(
      'SELECT user_id, display_name FROM ledger_members WHERE ledger_id = ?',
    )
    .all(ledgerId);
  return new Map(rows.map((row) => [row.user_id as UserId, row.display_name]));
}

// The user's active ledger, only while the user is still a member of it.
export function findActiveLedger(db: Db, userId: UserId): Ledger | undefined {
  const row = db
    .prepare<[string], LedgerRow>(
      `SELECT ${COLUMNS}
         FROM users u
         JOIN ledgers l ON l.id = u.active_ledger_id
         JOIN ledger_members m ON m.ledger_id = l.id AND m.user_id = u.id
        WHERE u.id = ?`,
    )
    .get(userId);
  return row === undefined ? undefined : toLedger(row);
}

// The ledger the user owns as their personal books.
export function findPersonalLedger(db: Db, userId: UserId): Ledger | undefined {
  const row = db
    .prepare<[string], LedgerRow>(
      `SELECT ${COLUMNS} FROM ledgers l WHERE l.owner_user_id = ? AND l.kind = 'personal'`,
    )
    .get(userId);
  return row === undefined ? undefined : toLedger(row);
}

// Any ledger by id, with no membership check: for routing by a chat binding, not for a user.
export function findLedgerById(db: Db, ledgerId: LedgerId): Ledger | undefined {
  const row = db
    .prepare<[string], LedgerRow>(`SELECT ${COLUMNS} FROM ledgers l WHERE l.id = ?`)
    .get(ledgerId);
  return row === undefined ? undefined : toLedger(row);
}

export function findLedgerForMember(
  db: Db,
  ledgerId: LedgerId,
  userId: UserId,
): Ledger | undefined {
  const row = db
    .prepare<[string, string], LedgerRow>(
      `SELECT ${COLUMNS}
         FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
        WHERE l.id = ? AND m.user_id = ?`,
    )
    .get(ledgerId, userId);
  return row === undefined ? undefined : toLedger(row);
}

export type LedgerRole = 'owner' | 'member';

// The user's role in the ledger; undefined for a non-member.
export function findMemberRole(db: Db, ledgerId: LedgerId, userId: UserId): LedgerRole | undefined {
  return db
    .prepare<[string, string], LedgerRole>(
      'SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?',
    )
    .pluck()
    .get(ledgerId, userId);
}

// Returns false when the ledger already has this currency: nothing is written.
export function updateLedgerCurrency(db: Db, ledgerId: LedgerId, currency: CurrencyCode): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        'UPDATE ledgers SET default_currency = ? WHERE id = ? AND default_currency <> ?',
      )
      .run(currency, ledgerId, currency).changes > 0
  );
}

// A shared ledger's zone. Returns false when it already has this zone: nothing is written.
// Recorded rows keep their occurred_on (ADR-0015).
export function updateLedgerTimezone(db: Db, ledgerId: LedgerId, timezone: string): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        `UPDATE ledgers SET timezone = ?
          WHERE id = ? AND kind = 'shared' AND timezone IS NOT ?`,
      )
      .run(timezone, ledgerId, timezone).changes > 0
  );
}

// Deletes the ledger row with what hangs off it alone: its sealed key and wraps (ADR-0020), its
// memberships, and any active-ledger pointer at it. Run it after the ledger's expenses,
// receipts, budget, caps and categories are gone.
export function deleteLedger(db: Db, ledgerId: LedgerId): void {
  db.prepare<[string]>('DELETE FROM ledger_key_wraps WHERE ledger_id = ?').run(ledgerId);
  db.prepare<[string]>('DELETE FROM ledger_keys WHERE ledger_id = ?').run(ledgerId);
  db.prepare<[string]>('DELETE FROM ledger_members WHERE ledger_id = ?').run(ledgerId);
  db.prepare<[string]>('UPDATE users SET active_ledger_id = NULL WHERE active_ledger_id = ?').run(
    ledgerId,
  );
  db.prepare<[string]>('DELETE FROM ledgers WHERE id = ?').run(ledgerId);
}

// The user's display name in every ledger they belong to is forgotten: a group then shows them
// as a deleted member.
export function clearMemberDisplayNames(db: Db, userId: UserId): void {
  db.prepare<[string]>('UPDATE ledger_members SET display_name = NULL WHERE user_id = ?').run(
    userId,
  );
}

function toLedger(row: LedgerRow): Ledger {
  const defaultCurrency = toCurrencyCode(row.default_currency);
  if (defaultCurrency === undefined) {
    throw new Error(`ledger ${row.id} has an unknown default currency`);
  }
  return {
    id: row.id as LedgerId,
    kind: row.kind,
    name: row.name,
    defaultCurrency,
    timezone: row.timezone,
  };
}
