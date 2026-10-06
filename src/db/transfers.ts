import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';
import type { UserId } from './users.js';

// Transfers between members of a shared ledger (ADR-0030): each squares part of a settle-up
// balance in its own currency. Balances are computed in the domain, never stored.

export type TransferId = string & { readonly __brand: 'TransferId' };

export interface Transfer {
  readonly id: TransferId;
  readonly ledgerId: LedgerId;
  readonly fromUser: UserId;
  readonly toUser: UserId;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly deletedAt: Date | null;
}

interface Row {
  id: string;
  ledger_id: string;
  from_user: string;
  to_user: string;
  amount_minor: number;
  currency: string;
  deleted_at: string | null;
}

const COLUMNS = 'id, ledger_id, from_user, to_user, amount_minor, currency, deleted_at';

// Inserts unless the source key exists; either way returns the stored transfer.
export function insertTransferOrGetExisting(
  db: Db,
  transfer: Omit<Transfer, 'deletedAt'> & {
    readonly createdBy: UserId;
    readonly sourceKey: string;
    readonly createdAt: Date;
  },
): { readonly transfer: Transfer; readonly created: boolean } {
  const { changes } = db
    .prepare<[string, string, string, string, number, string, string, string, string]>(
      `INSERT INTO ledger_transfers (id, ledger_id, from_user, to_user, amount_minor, currency,
                                     created_by, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
    )
    .run(
      transfer.id,
      transfer.ledgerId,
      transfer.fromUser,
      transfer.toUser,
      transfer.amountMinor,
      transfer.currency,
      transfer.createdBy,
      transfer.sourceKey,
      transfer.createdAt.toISOString(),
    );
  const row = db
    .prepare<[string], Row>(`SELECT ${COLUMNS} FROM ledger_transfers WHERE source_key = ?`)
    .get(transfer.sourceKey);
  if (row === undefined) throw new Error('transfer vanished after insert');
  return { transfer: toTransfer(row), created: changes === 1 };
}

export function findTransfer(db: Db, id: TransferId): Transfer | undefined {
  const row = db
    .prepare<[string], Row>(`SELECT ${COLUMNS} FROM ledger_transfers WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : toTransfer(row);
}

// The ledger's live transfers, oldest first.
export function listLedgerTransfers(db: Db, ledgerId: LedgerId): Transfer[] {
  return db
    .prepare<[string], Row>(
      `SELECT ${COLUMNS} FROM ledger_transfers
        WHERE ledger_id = ? AND deleted_at IS NULL
        ORDER BY created_at, rowid`,
    )
    .all(ledgerId)
    .map(toTransfer);
}

// Returns false when the transfer was deleted already.
export function softDeleteTransfer(db: Db, id: TransferId, deletedAt: Date): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      'UPDATE ledger_transfers SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(deletedAt.toISOString(), id);
  return changes === 1;
}

function toTransfer(row: Row): Transfer {
  const currency = toCurrencyCode(row.currency);
  if (currency === undefined) throw new Error(`transfer ${row.id} has an unknown currency`);
  return {
    id: row.id as TransferId,
    ledgerId: row.ledger_id as LedgerId,
    fromUser: row.from_user as UserId,
    toUser: row.to_user as UserId,
    amountMinor: row.amount_minor,
    currency,
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
  };
}
