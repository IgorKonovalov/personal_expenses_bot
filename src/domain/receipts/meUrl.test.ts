import { describe, expect, it } from 'vitest';
import { decodeReceiptUrl } from './index.js';
import { decodeMeUrl } from './meUrl.js';
import { buildRsUrl } from './testing/buildRsVl.js';

const IIC = '0123456789ABCDEF0123456789ABCDEF';

function meUrl(params: Record<string, string>): string {
  const query = Object.entries({
    iic: IIC,
    tin: '02000000',
    crtd: '2026-09-30T23:15:00+02:00',
    prc: '42.50',
    bu: 'ab123cd456',
    cr: 'xy987zz123',
    sw: 'sw111aa222',
    ...params,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return `https://mapr.tax.gov.me/ic/#/verify?${query}`;
}

describe('decodeMeUrl', () => {
  it('reads the total, instant, iic and merchant from the hash fragment', () => {
    expect(decodeMeUrl(meUrl({}))).toEqual({
      kind: 'receipt',
      receipt: {
        country: 'ME',
        totalMinor: 4250,
        currency: 'EUR',
        fiscalId: IIC.toLowerCase(),
        issuedAt: new Date('2026-09-30T21:15:00Z'),
        merchantKey: 'me:02000000:ab123cd456',
        verifyUrl:
          'https://mapr.tax.gov.me/ic/#/verify?iic=0123456789abcdef0123456789abcdef&tin=02000000&crtd=2026-09-30T23%3A15%3A00%2B02%3A00&prc=42.50',
      },
    });
  });

  it.each([
    ['42', 4200],
    ['42.5', 4250],
  ])('reads prc=%s as %i minor', (prc, minor) => {
    expect(decodeMeUrl(meUrl({ prc }))).toMatchObject({ receipt: { totalMinor: minor } });
  });

  it.each(['42.505', '-1', '0', '4,50'])('refuses prc=%s', (prc) => {
    expect(decodeMeUrl(meUrl({ prc })).kind).toBe('refused');
  });

  it('decodes crtd the same when its + arrived as a space or as %2B', () => {
    const expected = { receipt: { issuedAt: new Date('2026-09-30T21:15:00Z') } };

    expect(decodeMeUrl(meUrl({ crtd: '2026-09-30T23:15:00 02:00' }))).toMatchObject(expected);
    expect(decodeMeUrl(meUrl({ crtd: '2026-09-30T23:15:00%2B02:00' }))).toMatchObject(expected);
    expect(decodeMeUrl(meUrl({ crtd: '2026-09-30T23:15:00%2002:00' }))).toMatchObject(expected);
  });

  it('refuses an iic that is not 32 hex digits', () => {
    expect(decodeMeUrl(meUrl({ iic: 'xyz' }))).toEqual({ kind: 'refused', reason: 'malformed' });
  });

  it('decodes the host with :443 like the portless link, with a portless verifyUrl', () => {
    const link = meUrl({}).replace('mapr.tax.gov.me/', 'mapr.tax.gov.me:443/');
    expect(link).toContain('https://mapr.tax.gov.me:443/ic/#/verify?');

    const result = decodeMeUrl(link);

    expect(result).toEqual(decodeMeUrl(meUrl({})));
    expect(result).toMatchObject({
      kind: 'receipt',
      receipt: {
        totalMinor: 4250,
        verifyUrl:
          'https://mapr.tax.gov.me/ic/#/verify?iic=0123456789abcdef0123456789abcdef&tin=02000000&crtd=2026-09-30T23%3A15%3A00%2B02%3A00&prc=42.50',
      },
    });
  });

  it('is not a receipt on the host with another port', () => {
    const link = meUrl({}).replace('mapr.tax.gov.me/', 'mapr.tax.gov.me:8443/');

    expect(decodeMeUrl(link)).toEqual({ kind: 'notReceipt' });
  });

  it('is not a receipt next to other words or on another host', () => {
    expect(decodeMeUrl(`кофе ${meUrl({})}`)).toEqual({ kind: 'notReceipt' });
    expect(decodeMeUrl('https://example.com/ic/#/verify?iic=1')).toEqual({ kind: 'notReceipt' });
  });
});

describe('decodeReceiptUrl', () => {
  it('decodes both countries and nothing else', () => {
    expect(decodeReceiptUrl(buildRsUrl())).toMatchObject({ receipt: { country: 'RS' } });
    expect(decodeReceiptUrl(meUrl({}))).toMatchObject({ receipt: { country: 'ME' } });
    expect(decodeReceiptUrl('450 кофе')).toEqual({ kind: 'notReceipt' });
  });
});
