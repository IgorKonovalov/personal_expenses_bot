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
}

interface LedgerRow {
  id: string;
  kind: LedgerKind;
  name: string;
  default_currency: string;
}

export function insertLedger(
  db: Db,
  ledger: Ledger & { ownerUserId: UserId; createdAt: Date },
): void {
  db.prepare<[string, string, string, string, string, string]>(
    `INSERT INTO ledgers (id, kind, name, default_currency, owner_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    ledger.id,
    ledger.kind,
    ledger.name,
    ledger.defaultCurrency,
    ledger.ownerUserId,
    ledger.createdAt.toISOString(),
  );
}

export function insertMember(
  db: Db,
  member: { ledgerId: LedgerId; userId: UserId; role: LedgerRole },
): void {
  db.prepare<[string, string, string]>(
    'INSERT INTO ledger_members (ledger_id, user_id, role) VALUES (?, ?, ?)',
  ).run(member.ledgerId, member.userId, member.role);
}

// The user's active ledger, only while the user is still a member of it.
export function findActiveLedger(db: Db, userId: UserId): Ledger | undefined {
  const row = db
    .prepare<[string], LedgerRow>(
      `SELECT l.id, l.kind, l.name, l.default_currency
         FROM users u
         JOIN ledgers l ON l.id = u.active_ledger_id
         JOIN ledger_members m ON m.ledger_id = l.id AND m.user_id = u.id
        WHERE u.id = ?`,
    )
    .get(userId);
  return row === undefined ? undefined : toLedger(row);
}

export function findLedgerForMember(
  db: Db,
  ledgerId: LedgerId,
  userId: UserId,
): Ledger | undefined {
  const row = db
    .prepare<[string, string], LedgerRow>(
      `SELECT l.id, l.kind, l.name, l.default_currency
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

function toLedger(row: LedgerRow): Ledger {
  const defaultCurrency = toCurrencyCode(row.default_currency);
  if (defaultCurrency === undefined) {
    throw new Error(`ledger ${row.id} has an unknown default currency`);
  }
  return { id: row.id as LedgerId, kind: row.kind, name: row.name, defaultCurrency };
}
