import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

// The sealed-ledger crypto of ADR-0020, on node:crypto only. A row is sealed to the ledger's
// X25519 public key with an ephemeral exchange, HKDF-SHA256 and AES-256-GCM, so writing needs no
// secret. The ledger's private key is stored only wrapped (AES-256-GCM) under a key derived from
// a passphrase (Argon2id) or from the recovery code (HKDF-SHA256).
//
// Sealed blob: version(1) || ephemeralPub(32) || nonce(12) || ciphertext || tag(16).
// Wrap:        nonce(12) || ciphertext || tag(16).
// Every open and unwrap throws on a wrong key, a wrong associated data or a flipped byte.

const SEAL_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEAL_INFO = 'expenses-bot seal v1';
const RECOVERY_INFO = 'expenses-bot recovery v1';

// DER prefixes that turn a raw 32-byte X25519 key into SPKI / PKCS#8 (RFC 8410).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface LedgerKeypair {
  // Raw X25519, 32 bytes: stored in plaintext.
  readonly publicKey: Buffer;
  readonly privateKey: KeyObject;
}

export function generateLedgerKeypair(): LedgerKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: rawPublicKey(publicKey), privateKey };
}

function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
}

function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error('an X25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

// The private key as raw bytes, for wrapping only.
function rawPrivateKey(key: KeyObject): Buffer {
  return key.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_PREFIX.length);
}

function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error('an X25519 private key is 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

// The exchange key binds both public keys, so a blob re-addressed to another ledger won't open.
function sealKey(shared: Buffer, ephemeralPub: Buffer, recipientPub: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeralPub, recipientPub]), SEAL_INFO, KEY_BYTES),
  );
}

function encrypt(key: Buffer, plaintext: Uint8Array, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function decrypt(key: Buffer, boxed: Uint8Array, aad: string): Buffer {
  if (boxed.length < NONCE_BYTES + TAG_BYTES) throw new Error('sealed data is truncated');
  const bytes = Buffer.from(boxed);
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

// Seals `plaintext` to the raw X25519 `publicKey`. `aad` is bound but not stored: opening needs
// the same string.
export function seal(publicKey: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const recipient = publicKeyFromRaw(publicKey);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPub = rawPublicKey(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = sealKey(shared, ephemeralPub, rawPublicKey(recipient));
  return Buffer.concat([Buffer.of(SEAL_VERSION), ephemeralPub, encrypt(key, plaintext, aad)]);
}

export function open(blob: Uint8Array, privateKey: KeyObject, aad: string): Buffer {
  const bytes = Buffer.from(blob);
  if (bytes[0] !== SEAL_VERSION) throw new Error('unknown sealed blob version');
  const ephemeralPub = bytes.subarray(1, 1 + KEY_BYTES);
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(ephemeralPub) });
  const key = sealKey(shared, ephemeralPub, rawPublicKey(createPublicKey(privateKey)));
  return decrypt(key, bytes.subarray(1 + KEY_BYTES), aad);
}

// Argon2id parameters, stored per wrap so they can change without a migration. `memory` is in
// KiB, as node:crypto takes it.
export interface Argon2idParams {
  readonly salt: Buffer;
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

// 64 MiB, 3 passes, parallelism 1 (Plan 0019 Data shapes).
export function newArgon2idParams(): Argon2idParams {
  return { salt: randomBytes(16), memory: 64 * 1024, passes: 3, parallelism: 1 };
}

// Runs off the event loop: at these parameters a derivation takes on the order of 100 ms.
export function derivePassphraseKey(passphrase: string, params: Argon2idParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(passphrase.normalize('NFC'), 'utf8'),
        nonce: params.salt,
        memory: params.memory,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength: KEY_BYTES,
      },
      (error, key) => {
        if (error === null) resolve(key);
        else reject(error);
      },
    );
  });
}

// The recovery code is 160 random bits, so a fast KDF is enough.
export function deriveRecoveryKey(code: Uint8Array, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', code, salt, RECOVERY_INFO, KEY_BYTES));
}

export function wrapPrivateKey(kek: Buffer, privateKey: KeyObject, aad: string): Buffer {
  return encrypt(kek, rawPrivateKey(privateKey), aad);
}

export function unwrapPrivateKey(kek: Buffer, wrapped: Uint8Array, aad: string): KeyObject {
  return privateKeyFromRaw(decrypt(kek, wrapped, aad));
}

// RFC 4648 base32: 160 bits are exactly 32 characters, shown as 8 groups of 4.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_BYTES = 20;
const RECOVERY_CHARS = 32;

export function newRecoveryCode(): Buffer {
  return randomBytes(RECOVERY_BYTES);
}

export function formatRecoveryCode(code: Uint8Array): string {
  if (code.length !== RECOVERY_BYTES) throw new Error('a recovery code is 20 bytes');
  let bits = '';
  for (const byte of code) bits += byte.toString(2).padStart(8, '0');
  let chars = '';
  for (let i = 0; i < bits.length; i += 5)
    chars += BASE32.charAt(parseInt(bits.slice(i, i + 5), 2));
  return (chars.match(/.{4}/g) ?? []).join('-');
}

// Case-insensitive; spaces, dashes and other separators are ignored. Undefined for anything
// that isn't 32 base32 characters.
export function parseRecoveryCode(text: string): Buffer | undefined {
  const chars = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (chars.length !== RECOVERY_CHARS) return undefined;
  let bits = '';
  for (const char of chars) {
    const value = BASE32.indexOf(char);
    if (value < 0) return undefined;
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.alloc(RECOVERY_BYTES);
  for (let i = 0; i < RECOVERY_BYTES; i += 1) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

// What a sealed expense row holds. Amounts stay integer minor units inside the blob too.
export interface SealedPayloadV1 {
  readonly v: 1;
  readonly amountMinor: number;
  readonly description: string;
  readonly categoryId: number | null;
  readonly receipt?: SealedReceipt;
}

export interface SealedReceipt {
  readonly sellerName: string | null;
  readonly verifyUrl: string;
  readonly items: readonly {
    readonly name: string;
    // Decimal source text, e.g. `0.535`: a quantity, not money.
    readonly quantity: string;
    readonly totalMinor: number;
  }[];
}

export function encodePayload(payload: SealedPayloadV1): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

// Throws on any shape but v1, and on a non-integer or non-positive amount: a bad amount is
// rejected, never rounded.
export function decodePayload(bytes: Uint8Array): SealedPayloadV1 {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (typeof value !== 'object' || value === null) throw new Error('sealed payload is no object');
  const p = value as Record<string, unknown>;
  if (p.v !== 1) throw new Error('unknown sealed payload version');
  if (!isPositiveInteger(p.amountMinor)) throw new Error('sealed amount is no positive integer');
  if (typeof p.description !== 'string') throw new Error('sealed description is no string');
  const categoryId = p.categoryId;
  if (categoryId !== null && !isInteger(categoryId)) {
    throw new Error('sealed category is no integer');
  }
  const base: SealedPayloadV1 = {
    v: 1,
    amountMinor: p.amountMinor,
    description: p.description,
    categoryId,
  };
  return p.receipt === undefined ? base : { ...base, receipt: decodeReceipt(p.receipt) };
}

function decodeReceipt(value: unknown): SealedReceipt {
  if (typeof value !== 'object' || value === null) throw new Error('sealed receipt is no object');
  const r = value as Record<string, unknown>;
  if (r.sellerName !== null && typeof r.sellerName !== 'string') {
    throw new Error('sealed seller is no string');
  }
  if (typeof r.verifyUrl !== 'string') throw new Error('sealed receipt link is no string');
  if (!Array.isArray(r.items)) throw new Error('sealed receipt items are no list');
  const items = (r.items as unknown[]).map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('sealed item is no object');
    const i = item as Record<string, unknown>;
    if (typeof i.name !== 'string' || typeof i.quantity !== 'string') {
      throw new Error('sealed item fields are no strings');
    }
    if (!isInteger(i.totalMinor)) throw new Error('sealed item total is no integer');
    return { name: i.name, quantity: i.quantity, totalMinor: i.totalMinor };
  });
  return { sellerName: r.sellerName, verifyUrl: r.verifyUrl, items };
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}
