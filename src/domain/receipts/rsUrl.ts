import { createHash } from 'node:crypto';
import type { DecodeReceiptResult, ReceiptRefusal } from './types.js';

// The Serbian fiscal receipt (SUF) verification URL, `https://suf.purs.gov.rs/v/?vl=<base64>`.
// `vl` is a binary payload; every multi-byte field below is read at a fixed offset:
//
//   version u8 · requestedBy 8 ASCII · signedBy 8 ASCII · totalCounter u32 LE ·
//   transactionTypeCounter u32 LE · total u64 LE (amount × 10000) · issued u64 BE (Unix ms) ·
//   invoiceType u8 · transactionType u8 · buyerIdLength u8 · buyerId ·
//   encrypted internal data (256 or 512 bytes) · signature 256 · MD5 of all the preceding bytes 16
//
// The total has four implied decimals; RSD has two, so a total not divisible by 100 is refused
// rather than rounded (ADR-0018).

const URL_PATTERN = /^https?:\/\/suf\.purs\.gov\.rs\/v\/?\?([^#]*)(?:#.*)?$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISSUER_ID = /^[A-Za-z0-9]{8}$/;

const HEADER_BYTES = 44;
const SIGNATURE_BYTES = 256;
const HASH_BYTES = 16;
const INTERNAL_DATA_BYTES = new Set([256, 512]);

const INVOICE_NORMAL = 0;
const TRANSACTION_SALE = 0;
const TRANSACTION_REFUND = 1;

// The implied decimals of the total past RSD's two.
const TOTAL_SCALE = 100n;

export function decodeRsUrl(text: string): DecodeReceiptResult {
  const match = URL_PATTERN.exec(text.trim());
  if (match === null) return { kind: 'notReceipt' };
  const vl = vlParameter(match[1] ?? '');
  if (vl === undefined) return refused('malformed');
  return decodeVl(vl);
}

// The raw `vl` value, percent-decoded. A `+` survives as `+`, `%2B` becomes `+`, and a space,
// which is what form-style decoding makes of a `+`, is turned back into one. Base64 has no spaces.
function vlParameter(query: string): string | undefined {
  const raw = query
    .split('&')
    .find((part) => part.startsWith('vl='))
    ?.slice(3);
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw).replaceAll(' ', '+');
  } catch {
    return undefined;
  }
}

function decodeVl(vl: string): DecodeReceiptResult {
  if (!BASE64.test(vl) || vl.length % 4 !== 0) return refused('malformed');
  const bytes = Buffer.from(vl, 'base64');
  if (bytes.length < HEADER_BYTES + SIGNATURE_BYTES + HASH_BYTES) return refused('malformed');

  const hashAt = bytes.length - HASH_BYTES;
  const digest = createHash('md5').update(bytes.subarray(0, hashAt)).digest();
  if (!digest.equals(bytes.subarray(hashAt))) return refused('malformed');

  const requestedBy = bytes.toString('latin1', 1, 9);
  const signedBy = bytes.toString('latin1', 9, 17);
  const totalCounter = bytes.readUInt32LE(17);
  const rawTotal = bytes.readBigUInt64LE(25);
  const issuedMs = bytes.readBigUInt64BE(33);
  const invoiceType = bytes.readUInt8(41);
  const transactionType = bytes.readUInt8(42);
  const buyerIdLength = bytes.readUInt8(43);
  const internalData = hashAt - SIGNATURE_BYTES - HEADER_BYTES - buyerIdLength;
  if (!INTERNAL_DATA_BYTES.has(internalData)) return refused('malformed');
  if (!ISSUER_ID.test(requestedBy) || !ISSUER_ID.test(signedBy)) return refused('malformed');

  if (transactionType === TRANSACTION_REFUND) return refused('refund');
  if (transactionType !== TRANSACTION_SALE || invoiceType !== INVOICE_NORMAL) {
    return refused('notSale');
  }

  if (rawTotal % TOTAL_SCALE !== 0n) return refused('fractionalTotal');
  const minor = rawTotal / TOTAL_SCALE;
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return refused('malformed');
  if (issuedMs > BigInt(Number.MAX_SAFE_INTEGER)) return refused('malformed');
  const issuedAt = new Date(Number(issuedMs));
  if (Number.isNaN(issuedAt.getTime())) return refused('malformed');

  return {
    kind: 'receipt',
    receipt: {
      country: 'RS',
      fiscalId: `${requestedBy}-${signedBy}-${totalCounter}`,
      merchantKey: `rs:${requestedBy}`,
      totalMinor: Number(minor),
      currency: 'RSD',
      issuedAt,
      verifyUrl: `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(vl)}`,
    },
  };
}

function refused(reason: ReceiptRefusal): DecodeReceiptResult {
  return { kind: 'refused', reason };
}
