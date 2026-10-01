import { describe, expect, it } from 'vitest';
import { decodeRsUrl } from './rsUrl.js';
import { buildRsUrl, buildRsVl, buildRsVlBytes, type RsVlFields } from './testing/buildRsVl.js';

const SUF = 'https://suf.purs.gov.rs/v/?vl=';

describe('decodeRsUrl', () => {
  it('reads the total, instant, invoice number and merchant from a synthetic vl', () => {
    const vl = buildRsVl({
      rawTotal: 8291200n,
      issuedMs: 1_790_807_400_000,
      requestedBy: 'AAAA1111',
      signedBy: 'AAAA1111',
      totalCounter: 16898,
      invoiceType: 0,
      transactionType: 0,
    });

    expect(decodeRsUrl(`${SUF}${encodeURIComponent(vl)}`)).toEqual({
      kind: 'receipt',
      receipt: {
        country: 'RS',
        totalMinor: 82912,
        currency: 'RSD',
        fiscalId: 'AAAA1111-AAAA1111-16898',
        issuedAt: new Date('2026-09-30T22:30:00Z'),
        merchantKey: 'rs:AAAA1111',
        verifyUrl: `${SUF}${encodeURIComponent(vl)}`,
      },
    });
  });

  it('reads a payload with 512 bytes of internal data and a buyer id', () => {
    const result = decodeRsUrl(buildRsUrl({ internalDataBytes: 512, buyerId: '10:123456789' }));

    expect(result).toMatchObject({ kind: 'receipt', receipt: { totalMinor: 82912 } });
  });

  it('refuses a total that is not a whole number of para', () => {
    expect(decodeRsUrl(buildRsUrl({ rawTotal: 8291250n }))).toEqual({
      kind: 'refused',
      reason: 'fractionalTotal',
    });
  });

  it('refuses a payload with a flipped byte (MD5 mismatch)', () => {
    const bytes = buildRsVlBytes();
    bytes[30] = (bytes[30] ?? 0) ^ 0x01;

    expect(decodeRsUrl(`${SUF}${encodeURIComponent(bytes.toString('base64'))}`)).toEqual({
      kind: 'refused',
      reason: 'malformed',
    });
  });

  it('refuses a truncated payload', () => {
    const vl = buildRsVl();

    expect(decodeRsUrl(`${SUF}${encodeURIComponent(vl.slice(0, 400))}`)).toEqual({
      kind: 'refused',
      reason: 'malformed',
    });
  });

  it.each([1, 2, 3, 4])('refuses invoice type %i as not a sale', (invoiceType) => {
    expect(decodeRsUrl(buildRsUrl({ invoiceType }))).toEqual({
      kind: 'refused',
      reason: 'notSale',
    });
  });

  it('refuses a refund (transaction type 1)', () => {
    expect(decodeRsUrl(buildRsUrl({ transactionType: 1 }))).toEqual({
      kind: 'refused',
      reason: 'refund',
    });
  });

  it('decodes a + inside vl the same whether it arrives as +, %2B or a space', () => {
    // Search the counter until the base64 carries a `+`.
    let fields: RsVlFields = {};
    for (let counter = 1; !buildRsVl(fields).includes('+'); counter++) {
      fields = { totalCounter: counter };
    }
    const vl = buildRsVl(fields);
    const encoded = encodeURIComponent(vl);
    expect(encoded).toContain('%2B');

    const expected = decodeRsUrl(`${SUF}${encoded}`);
    expect(expected.kind).toBe('receipt');
    expect(decodeRsUrl(`${SUF}${vl}`)).toEqual(expected);
    expect(decodeRsUrl(`${SUF}${encoded.replaceAll('%2B', ' ')}`)).toEqual(expected);
  });

  it('is not a receipt when the link sits next to other words', () => {
    expect(decodeRsUrl(`кофе ${buildRsUrl()}`)).toEqual({ kind: 'notReceipt' });
  });

  it('is not a receipt on another host', () => {
    expect(decodeRsUrl('https://example.com/v/?vl=AAAA')).toEqual({ kind: 'notReceipt' });
  });

  it('refuses a SUF link without vl', () => {
    expect(decodeRsUrl('https://suf.purs.gov.rs/v/?x=1')).toEqual({
      kind: 'refused',
      reason: 'malformed',
    });
  });
});
