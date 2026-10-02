import type { KeyObject } from 'node:crypto';
import { findCategory, type CategoryId } from '../db/categories.js';
import type { Db } from '../db/connection.js';
import {
  findExpenseById,
  isSealed,
  type Expense,
  type ExpenseCategory,
  type ExpenseId,
  type SealedExpense,
  type StoredExpense,
} from '../db/expenses.js';
import {
  findKeyWrap,
  findLedgerPublicKey,
  insertKeyWrap,
  insertLedgerKeyOrIgnore,
  type KeyWrap,
  type KeyWrapper,
} from '../db/ledgerKeys.js';
import { findPersonalLedger, type Ledger, type LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import {
  decodePayload,
  deriveRecoveryKey,
  derivePassphraseKey,
  encodePayload,
  formatRecoveryCode,
  generateLedgerKeypair,
  newArgon2idParams,
  newRecoveryCode,
  open,
  seal,
  unwrapPrivateKey,
  wrapPrivateKey,
  type Argon2idParams,
  type SealedPayloadV1,
  type SealedReceipt,
} from '../domain/sealing.js';
import type { Logger } from '../logger.js';
import { completeFlow, startFlow } from './flowSessions.js';
import { hasPendingReceipts, scrubFreedPages, sealLedgerRows } from './sealLedger.js';

// Sealed ledgers (ADR-0020): a personal ledger's owner switches encryption on with a passphrase.
// Rows are sealed to the ledger's public key, so recording needs no unlock; reading needs the
// private key, which /unlock puts into this process's keyring. Nothing here logs a passphrase,
// a recovery code or a row's content: ids only.

export const MIN_PASSPHRASE_LENGTH = 10;

// The unlocked private keys of this process. A new keyring, like a restart, holds none.
export interface LedgerKeyring {
  // The ledger's private key while unlocked; undefined while locked.
  readonly privateKey: (ledgerId: LedgerId) => KeyObject | undefined;
  readonly hold: (ledgerId: LedgerId, privateKey: KeyObject) => void;
  // Returns false when the ledger was not unlocked.
  readonly lock: (ledgerId: LedgerId) => boolean;
}

export function createLedgerKeyring(): LedgerKeyring {
  const held = new Map<LedgerId, KeyObject>();
  return {
    privateKey: (ledgerId) => held.get(ledgerId),
    hold: (ledgerId, privateKey) => {
      held.set(ledgerId, privateKey);
    },
    lock: (ledgerId) => held.delete(ledgerId),
  };
}

export interface KeyDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly keys: LedgerKeyring;
}

// The associated data that binds a wrap to its ledger and holder, and a row to its ledger and id.
function wrapAad(ledgerId: LedgerId, who: KeyWrapper): string {
  return who.wrapper === 'member' ? `${ledgerId}:member:${who.userId}` : `${ledgerId}:recovery`;
}

export function rowAad(ledgerId: LedgerId, expenseId: string): string {
  return `${ledgerId}:${expenseId}`;
}

// The ledger's public key when it is sealed: what recording seals new rows to.
export function sealingKey({ db }: { readonly db: Db }, ledgerId: LedgerId): Buffer | undefined {
  return findLedgerPublicKey(db, ledgerId);
}

export function isSealedLedger(deps: { readonly db: Db }, ledgerId: LedgerId): boolean {
  return sealingKey(deps, ledgerId) !== undefined;
}

export function sealPayload(
  publicKey: Buffer,
  ids: { readonly ledgerId: LedgerId; readonly expenseId: string },
  payload: SealedPayloadV1,
): Buffer {
  return seal(publicKey, encodePayload(payload), rowAad(ids.ledgerId, ids.expenseId));
}

export type EncryptionState =
  | { readonly kind: 'off'; readonly ledger: Ledger }
  | { readonly kind: 'locked' | 'unlocked'; readonly ledger: Ledger };

// The user's personal ledger and whether it is sealed, and unlocked.
export function encryptionState(deps: KeyDeps, user: User): EncryptionState {
  const ledger = personalLedger(deps.db, user);
  if (!isSealedLedger(deps, ledger.id)) return { kind: 'off', ledger };
  return { kind: deps.keys.privateKey(ledger.id) === undefined ? 'locked' : 'unlocked', ledger };
}

function personalLedger(db: Db, user: User): Ledger {
  const ledger = findPersonalLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no personal ledger`);
  return ledger;
}

// Starts the enable prompt. False when the personal ledger is already sealed.
export function startEnableFlow(deps: KeyDeps, user: User, now: Date): boolean {
  const ledger = personalLedger(deps.db, user);
  if (isSealedLedger(deps, ledger.id)) return false;
  startFlow(deps, user, { kind: 'encryptionEnable', ledgerId: ledger.id }, now);
  return true;
}

export type EnableResult =
  | { readonly kind: 'enabled'; readonly ledger: Ledger; readonly recoveryCode: string }
  // The flow stays pending and the prompt is asked again.
  | { readonly kind: 'tooShort' }
  // The flow is answered, nothing written. `pendingReceipts`: a receipt of the ledger is still
  // being fetched.
  | { readonly kind: 'alreadyEnabled' | 'pendingReceipts' };

// Seals the user's personal ledger: a new keypair, its private key wrapped under the
// passphrase and under a fresh recovery code, and every expense already recorded sealed to it.
// The key rows, the sealed rows and the flow's completion commit together, keyed by
// `inputKey`; a failure leaves every row plaintext and no key, and a redelivered or repeated
// enable finds the key and writes no second one. The recovery code is returned once and stored
// nowhere.
export async function enableEncryption(
  deps: KeyDeps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly passphrase: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): Promise<EnableResult> {
  const { db, logger } = deps;
  const { user } = input;
  const ledger = personalLedger(db, user);
  if (ledger.id !== input.ledgerId || isSealedLedger(deps, ledger.id)) {
    completeFlow(deps, user, input.inputKey);
    return { kind: 'alreadyEnabled' };
  }
  if (Array.from(input.passphrase).length < MIN_PASSPHRASE_LENGTH) return { kind: 'tooShort' };
  if (hasPendingReceipts(db, ledger.id)) {
    completeFlow(deps, user, input.inputKey);
    return { kind: 'pendingReceipts' };
  }

  const { publicKey, privateKey } = generateLedgerKeypair();
  const member: KeyWrapper = { wrapper: 'member', userId: user.id };
  const memberWrap = await passphraseWrap(input.passphrase, privateKey, wrapAad(ledger.id, member));
  const code = newRecoveryCode();
  const recoveryWrap = codeWrap(code, privateKey, wrapAad(ledger.id, { wrapper: 'recovery' }));

  const result = db.transaction((): EnableResult => {
    completeFlow(deps, user, input.inputKey);
    if (hasPendingReceipts(db, ledger.id)) return { kind: 'pendingReceipts' };
    if (!insertLedgerKeyOrIgnore(db, { ledgerId: ledger.id, publicKey, createdAt: input.now })) {
      return { kind: 'alreadyEnabled' };
    }
    insertKeyWrap(db, ledger.id, member, memberWrap);
    insertKeyWrap(db, ledger.id, { wrapper: 'recovery' }, recoveryWrap);
    const sealed = sealLedgerRows(db, ledger.id, (expenseId, payload) =>
      sealPayload(publicKey, { ledgerId: ledger.id, expenseId }, payload),
    );
    logger.info({ ledgerId: ledger.id, userId: user.id, rows: sealed }, 'ledger sealed');
    return { kind: 'enabled', ledger, recoveryCode: formatRecoveryCode(code) };
  })();
  if (result.kind === 'enabled') scrubFreedPages(db);
  return result;
}

async function passphraseWrap(
  passphrase: string,
  privateKey: KeyObject,
  aad: string,
): Promise<KeyWrap> {
  const params = newArgon2idParams();
  const kek = await derivePassphraseKey(passphrase, params);
  return {
    kdf: 'argon2id',
    kdfParams: JSON.stringify({
      salt: params.salt.toString('base64'),
      memory: params.memory,
      passes: params.passes,
      parallelism: params.parallelism,
    }),
    wrappedPrivate: wrapPrivateKey(kek, privateKey, aad),
  };
}

function codeWrap(code: Buffer, privateKey: KeyObject, aad: string): KeyWrap {
  const salt = newArgon2idParams().salt;
  return {
    kdf: 'hkdf-sha256',
    kdfParams: JSON.stringify({ salt: salt.toString('base64') }),
    wrappedPrivate: wrapPrivateKey(deriveRecoveryKey(code, salt), privateKey, aad),
  };
}

function argon2idParamsOf(json: string): Argon2idParams {
  const p = JSON.parse(json) as Record<string, unknown>;
  if (
    typeof p.salt !== 'string' ||
    typeof p.memory !== 'number' ||
    typeof p.passes !== 'number' ||
    typeof p.parallelism !== 'number'
  ) {
    throw new Error('argon2id parameters are malformed');
  }
  return {
    salt: Buffer.from(p.salt, 'base64'),
    memory: p.memory,
    passes: p.passes,
    parallelism: p.parallelism,
  };
}

// The private key under the member's passphrase; undefined for a wrong passphrase.
async function unwrapWithPassphrase(
  wrap: KeyWrap,
  passphrase: string,
  aad: string,
): Promise<KeyObject | undefined> {
  if (wrap.kdf !== 'argon2id') throw new Error('a member wrap is argon2id');
  const kek = await derivePassphraseKey(passphrase, argon2idParamsOf(wrap.kdfParams));
  try {
    return unwrapPrivateKey(kek, wrap.wrappedPrivate, aad);
  } catch {
    return undefined;
  }
}

// Starts the /unlock prompt for the personal ledger. `off` when it isn't sealed, `unlocked`
// when it already is: no flow then.
export function startUnlockFlow(
  deps: KeyDeps,
  user: User,
  now: Date,
): 'asked' | 'off' | 'unlocked' {
  const state = encryptionState(deps, user);
  if (state.kind !== 'locked') return state.kind;
  startFlow(deps, user, { kind: 'unlock', ledgerId: state.ledger.id }, now);
  return 'asked';
}

export type UnlockResult = { readonly kind: 'unlocked' | 'wrongPassphrase' | 'notSealed' };

// One attempt per prompt: the flow is answered either way, so a later text is never taken as a
// passphrase.
export async function unlockLedger(
  deps: KeyDeps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly passphrase: string;
    readonly inputKey: string;
  },
): Promise<UnlockResult> {
  const { db, logger, keys } = deps;
  const { user, ledgerId } = input;
  completeFlow(deps, user, input.inputKey);
  const member: KeyWrapper = { wrapper: 'member', userId: user.id };
  const wrap = findKeyWrap(db, ledgerId, member);
  if (wrap === undefined) return { kind: 'notSealed' };
  const privateKey = await unwrapWithPassphrase(wrap, input.passphrase, wrapAad(ledgerId, member));
  if (privateKey === undefined) {
    logger.info({ ledgerId, userId: user.id }, 'unlock refused');
    return { kind: 'wrongPassphrase' };
  }
  keys.hold(ledgerId, privateKey);
  logger.info({ ledgerId, userId: user.id }, 'ledger unlocked');
  return { kind: 'unlocked' };
}

// A read of a sealed ledger while it is locked.
export interface Locked {
  readonly kind: 'locked';
}

export const LOCKED: Locked = { kind: 'locked' };

export function isLocked(value: object | undefined): value is Locked {
  return value !== undefined && 'kind' in value && value.kind === 'locked';
}

// The ledger is sealed and this process holds no key for it.
export function ledgerIsLocked(deps: Pick<KeyDeps, 'db' | 'keys'>, ledgerId: LedgerId): boolean {
  return isSealedLedger(deps, ledgerId) && deps.keys.privateKey(ledgerId) === undefined;
}

export type Opened = { readonly kind: 'open'; readonly expenses: Expense[] } | Locked;

// The one decrypting seam: a sealed ledger's rows open with its unlocked key, else the whole
// read is `locked`, whether or not it has rows. A plaintext ledger's rows pass through.
export function openExpenses(
  deps: Pick<KeyDeps, 'db' | 'keys'>,
  ledgerId: LedgerId,
  rows: readonly StoredExpense[],
): Opened {
  if (!isSealedLedger(deps, ledgerId)) return { kind: 'open', expenses: rows.map(plaintext) };
  const privateKey = deps.keys.privateKey(ledgerId);
  if (privateKey === undefined) return LOCKED;
  const categoryOf = categoryLookup(deps.db, ledgerId);
  return {
    kind: 'open',
    expenses: rows.map((row) => (isSealed(row) ? openRow(row, privateKey, categoryOf) : row)),
  };
}

// For the paths a sealed row never reaches (receipts, which a sealed ledger has none of, and
// shared ledgers, which are never sealed): reaching one is a bug, not a lock.
export function plaintext(row: StoredExpense): Expense {
  if (isSealed(row)) throw new Error(`sealed expense ${row.id} on a plaintext-only path`);
  return row;
}

// One stored expense, opened when its ledger is sealed and unlocked. Check who may see it on
// the stored row first: `locked` tells the caller the ledger is sealed.
export function openExpense(
  deps: Pick<KeyDeps, 'db' | 'keys'>,
  stored: StoredExpense,
): Expense | Locked {
  const opened = openExpenses(deps, stored.ledgerId, [stored]);
  if (opened.kind === 'locked') return opened;
  const [expense] = opened.expenses;
  if (expense === undefined) throw new Error(`expense ${stored.id} did not open`);
  return expense;
}

// The receipt folded into a sealed row's payload when its ledger was sealed. Undefined for a
// plaintext row, a row without one, or a locked ledger.
export function foldedReceipt(
  deps: Pick<KeyDeps, 'db' | 'keys'>,
  expenseId: ExpenseId,
): SealedReceipt | undefined {
  const stored = findExpenseById(deps.db, expenseId);
  if (stored === undefined || !isSealed(stored)) return undefined;
  const privateKey = deps.keys.privateKey(stored.ledgerId);
  if (privateKey === undefined) return undefined;
  return decodePayload(open(stored.sealed, privateKey, rowAad(stored.ledgerId, stored.id))).receipt;
}

// The row's payload with `change` applied, sealed again to the ledger's public key. The
// receipt part, if any, is carried over. The ledger must be unlocked.
export function resealed(
  deps: Pick<KeyDeps, 'db' | 'keys'>,
  row: SealedExpense,
  change: Partial<Pick<SealedPayloadV1, 'amountMinor' | 'description' | 'categoryId'>>,
): Buffer {
  const privateKey = deps.keys.privateKey(row.ledgerId);
  const publicKey = sealingKey(deps, row.ledgerId);
  if (privateKey === undefined || publicKey === undefined) {
    throw new Error(`ledger ${row.ledgerId} is locked or plaintext`);
  }
  const current = decodePayload(open(row.sealed, privateKey, rowAad(row.ledgerId, row.id)));
  return sealPayload(
    publicKey,
    { ledgerId: row.ledgerId, expenseId: row.id },
    {
      ...current,
      ...change,
    },
  );
}

function categoryLookup(db: Db, ledgerId: LedgerId): (id: number | null) => ExpenseCategory | null {
  const seen = new Map<number, ExpenseCategory | null>();
  return (id) => {
    if (id === null) return null;
    if (!seen.has(id)) {
      const category = findCategory(db, ledgerId, id as CategoryId);
      seen.set(id, category === undefined ? null : { id: category.id, name: category.name });
    }
    return seen.get(id) ?? null;
  };
}

function openRow(
  row: SealedExpense,
  privateKey: KeyObject,
  categoryOf: (id: number | null) => ExpenseCategory | null,
): Expense {
  const payload = decodePayload(open(row.sealed, privateKey, rowAad(row.ledgerId, row.id)));
  return {
    id: row.id,
    ledgerId: row.ledgerId,
    createdBy: row.createdBy,
    amountMinor: payload.amountMinor,
    currency: row.currency,
    description: payload.description,
    occurredAt: row.occurredAt,
    occurredOn: row.occurredOn,
    sourceKey: row.sourceKey,
    deletedAt: row.deletedAt,
    category: categoryOf(payload.categoryId),
  };
}
