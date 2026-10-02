import type { Db } from './connection.js';
import type { LedgerId } from './ledgers.js';
import type { UserId } from './users.js';

// A sealed ledger's keys (ADR-0020): the public key in plaintext, the private key only wrapped.
// The KDF parameter JSON is opaque here; the ledger-keys service owns its shape.

export type KeyWrapper =
  { readonly wrapper: 'member'; readonly userId: UserId } | { readonly wrapper: 'recovery' };

export interface KeyWrap {
  readonly kdf: 'argon2id' | 'hkdf-sha256';
  readonly kdfParams: string;
  readonly wrappedPrivate: Buffer;
}

// Returns false when the ledger already has a key, leaving it unchanged: a redelivered enable
// creates no second keypair.
export function insertLedgerKeyOrIgnore(
  db: Db,
  key: { readonly ledgerId: LedgerId; readonly publicKey: Buffer; readonly createdAt: Date },
): boolean {
  const { changes } = db
    .prepare<[string, Buffer, string]>(
      `INSERT INTO ledger_keys (ledger_id, public_key, created_at) VALUES (?, ?, ?)
       ON CONFLICT (ledger_id) DO NOTHING`,
    )
    .run(key.ledgerId, key.publicKey, key.createdAt.toISOString());
  return changes === 1;
}

// The raw X25519 public key of a sealed ledger; undefined for a plaintext one.
export function findLedgerPublicKey(db: Db, ledgerId: LedgerId): Buffer | undefined {
  return db
    .prepare<[string], Buffer>('SELECT public_key FROM ledger_keys WHERE ledger_id = ?')
    .pluck()
    .get(ledgerId);
}

export function insertKeyWrap(db: Db, ledgerId: LedgerId, who: KeyWrapper, wrap: KeyWrap): void {
  db.prepare<[string, string, string | null, string, string, Buffer]>(
    `INSERT INTO ledger_key_wraps (ledger_id, wrapper, user_id, kdf, kdf_params, wrapped_private)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    ledgerId,
    who.wrapper,
    who.wrapper === 'member' ? who.userId : null,
    wrap.kdf,
    wrap.kdfParams,
    wrap.wrappedPrivate,
  );
}

interface WrapRow {
  kdf: KeyWrap['kdf'];
  kdf_params: string;
  wrapped_private: Buffer;
}

export function findKeyWrap(db: Db, ledgerId: LedgerId, who: KeyWrapper): KeyWrap | undefined {
  const row =
    who.wrapper === 'member'
      ? db
          .prepare<[string, string], WrapRow>(
            `SELECT kdf, kdf_params, wrapped_private FROM ledger_key_wraps
              WHERE ledger_id = ? AND wrapper = 'member' AND user_id = ?`,
          )
          .get(ledgerId, who.userId)
      : db
          .prepare<[string], WrapRow>(
            `SELECT kdf, kdf_params, wrapped_private FROM ledger_key_wraps
              WHERE ledger_id = ? AND wrapper = 'recovery'`,
          )
          .get(ledgerId);
  return row === undefined
    ? undefined
    : { kdf: row.kdf, kdfParams: row.kdf_params, wrappedPrivate: row.wrapped_private };
}
