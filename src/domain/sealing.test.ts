import { describe, expect, it } from 'vitest';
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
  parseRecoveryCode,
  seal,
  unwrapPrivateKey,
  wrapPrivateKey,
} from './sealing.js';

const AAD = 'ledger-1:expense-1';

describe('seal / open', () => {
  const { publicKey, privateKey } = generateLedgerKeypair();
  const plaintext = Buffer.from('450 кофе', 'utf8');

  it('opens what it sealed, with the same associated data', () => {
    expect(publicKey).toHaveLength(32);
    expect(open(seal(publicKey, plaintext, AAD), privateKey, AAD).toString('utf8')).toBe(
      '450 кофе',
    );
  });

  it('seals the same plaintext to a different blob each time', () => {
    expect(seal(publicKey, plaintext, AAD).equals(seal(publicKey, plaintext, AAD))).toBe(false);
  });

  it('throws on every flipped byte of the blob', () => {
    const blob = seal(publicKey, plaintext, AAD);
    for (let i = 0; i < blob.length; i += 1) {
      const flipped = Buffer.from(blob);
      flipped[i] = (flipped[i] ?? 0) ^ 0x01;
      expect(() => open(flipped, privateKey, AAD), `byte ${i}`).toThrow();
    }
  });

  it('throws with a different associated data', () => {
    const blob = seal(publicKey, plaintext, AAD);
    expect(() => open(blob, privateKey, 'ledger-1:expense-2')).toThrow();
  });

  it("throws with another ledger's private key", () => {
    const blob = seal(publicKey, plaintext, AAD);
    expect(() => open(blob, generateLedgerKeypair().privateKey, AAD)).toThrow();
  });
});

describe('wrap / unwrap', () => {
  const { publicKey, privateKey } = generateLedgerKeypair();
  const blob = seal(publicKey, Buffer.from('1200 такси'), AAD);

  it('a passphrase wrap unwraps with the same passphrase, and the key opens rows', async () => {
    const params = newArgon2idParams();
    const kek = await derivePassphraseKey('correct horse 42', params);
    const wrapped = wrapPrivateKey(kek, privateKey, 'ledger-1:member');
    const again = await derivePassphraseKey('correct horse 42', params);
    const unwrapped = unwrapPrivateKey(again, wrapped, 'ledger-1:member');
    expect(open(blob, unwrapped, AAD).toString()).toBe('1200 такси');
  });

  it('a wrap made with passphrase X does not unwrap with X + "!"', async () => {
    const params = newArgon2idParams();
    const wrapped = wrapPrivateKey(
      await derivePassphraseKey('correct horse 42', params),
      privateKey,
      'ledger-1:member',
    );
    const wrong = await derivePassphraseKey('correct horse 42!', params);
    expect(() => unwrapPrivateKey(wrong, wrapped, 'ledger-1:member')).toThrow();
  });

  it('a recovery wrap unwraps only with the same code', () => {
    const code = newRecoveryCode();
    const salt = Buffer.alloc(16, 7);
    const wrapped = wrapPrivateKey(deriveRecoveryKey(code, salt), privateKey, 'ledger-1:recovery');
    const unwrapped = unwrapPrivateKey(deriveRecoveryKey(code, salt), wrapped, 'ledger-1:recovery');
    expect(open(blob, unwrapped, AAD).toString()).toBe('1200 такси');
    expect(() =>
      unwrapPrivateKey(deriveRecoveryKey(newRecoveryCode(), salt), wrapped, 'ledger-1:recovery'),
    ).toThrow();
  });
});

describe('recovery code', () => {
  it('is 160 bits shown as 8 groups of 4 base32 characters', () => {
    const code = newRecoveryCode();
    expect(code).toHaveLength(20);
    expect(formatRecoveryCode(code)).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
  });

  it('parses back case-insensitively, ignoring separators', () => {
    const code = newRecoveryCode();
    const shown = formatRecoveryCode(code);
    expect(parseRecoveryCode(shown)?.equals(code)).toBe(true);
    const typed = ` ${shown.toLowerCase().replaceAll('-', ' ')} `;
    expect(parseRecoveryCode(typed)?.equals(code)).toBe(true);
    expect(parseRecoveryCode(shown.replaceAll('-', ''))?.equals(code)).toBe(true);
  });

  it('refuses a wrong length or a non-base32 character', () => {
    const shown = formatRecoveryCode(newRecoveryCode());
    expect(parseRecoveryCode(shown.slice(0, -1))).toBeUndefined();
    expect(parseRecoveryCode(`${shown}A`)).toBeUndefined();
    expect(parseRecoveryCode(`1${shown.slice(1)}`)).toBeUndefined();
  });
});

describe('payload', () => {
  it('round-trips amount, description, category and receipt', () => {
    const payload = {
      v: 1 as const,
      amountMinor: 45000,
      description: 'кофе',
      categoryId: 3,
      receipt: {
        sellerName: 'Shop',
        verifyUrl: 'https://example.test/v',
        items: [{ name: 'Milk', quantity: '0.535', totalMinor: 12000 }],
      },
    };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });

  it('rejects a non-integer amount instead of rounding it', () => {
    const bytes = Buffer.from(
      JSON.stringify({ v: 1, amountMinor: 450.5, description: 'кофе', categoryId: null }),
    );
    expect(() => decodePayload(bytes)).toThrow(/amount/);
  });

  it('rejects an unknown version', () => {
    const bytes = Buffer.from(
      JSON.stringify({ v: 2, amountMinor: 450, description: 'кофе', categoryId: null }),
    );
    expect(() => decodePayload(bytes)).toThrow(/version/);
  });
});
