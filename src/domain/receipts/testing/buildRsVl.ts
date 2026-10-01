// Test-only: builds a synthetic SUF `vl` payload in the layout rsUrl.ts reads, MD5 included.
// The encrypted data and signature are filler bytes: nothing here is a real receipt.
import { createHash } from 'node:crypto';

export interface RsVlFields {
  readonly version?: number;
  readonly requestedBy?: string;
  readonly signedBy?: string;
  readonly totalCounter?: number;
  readonly transactionTypeCounter?: number;
  // The amount × 10000, as the payload stores it.
  readonly rawTotal?: bigint;
  readonly issuedMs?: number;
  readonly invoiceType?: number;
  readonly transactionType?: number;
  readonly buyerId?: string;
  readonly internalDataBytes?: 256 | 512;
}

export const RS_DEFAULTS = {
  requestedBy: 'AAAA1111',
  signedBy: 'AAAA1111',
  totalCounter: 16898,
  rawTotal: 8291200n,
  // 2026-09-30T22:30:00Z
  issuedMs: 1_790_807_400_000,
} as const;

export function buildRsVlBytes(fields: RsVlFields = {}): Buffer {
  const buyerId = Buffer.from(fields.buyerId ?? '', 'latin1');
  const header = Buffer.alloc(44);
  header.writeUInt8(fields.version ?? 0, 0);
  header.write(fields.requestedBy ?? RS_DEFAULTS.requestedBy, 1, 8, 'latin1');
  header.write(fields.signedBy ?? RS_DEFAULTS.signedBy, 9, 8, 'latin1');
  header.writeUInt32LE(fields.totalCounter ?? RS_DEFAULTS.totalCounter, 17);
  header.writeUInt32LE(fields.transactionTypeCounter ?? 1, 21);
  header.writeBigUInt64LE(fields.rawTotal ?? RS_DEFAULTS.rawTotal, 25);
  header.writeBigUInt64BE(BigInt(fields.issuedMs ?? RS_DEFAULTS.issuedMs), 33);
  header.writeUInt8(fields.invoiceType ?? 0, 41);
  header.writeUInt8(fields.transactionType ?? 0, 42);
  header.writeUInt8(buyerId.length, 43);
  const internalData = Buffer.alloc(fields.internalDataBytes ?? 256, 0x5a);
  const signature = Buffer.alloc(256, 0xa5);
  const body = Buffer.concat([header, buyerId, internalData, signature]);
  return Buffer.concat([body, createHash('md5').update(body).digest()]);
}

export function buildRsVl(fields: RsVlFields = {}): string {
  return buildRsVlBytes(fields).toString('base64');
}

// The verification URL as a QR code prints it, with `vl` percent-encoded.
export function buildRsUrl(fields: RsVlFields = {}): string {
  return `https://suf.purs.gov.rs/v/?vl=${encodeURIComponent(buildRsVl(fields))}`;
}
