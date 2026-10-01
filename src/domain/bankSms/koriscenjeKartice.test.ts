import { describe, expect, it } from 'vitest';
import { buildRsUrl } from '../receipts/testing/buildRsVl.js';
import { parseBankSms } from './index.js';
import { parseKoriscenjeKartice } from './koriscenjeKartice.js';
import { buildKoriscenjeSms } from './testing/buildKoriscenjeSms.js';

function purchase(text: string) {
  const result = parseKoriscenjeKartice(text);
  if (result.kind !== 'purchase') throw new Error(`expected a purchase, got ${result.kind}`);
  return result;
}

describe('parseKoriscenjeKartice', () => {
  it('reads the charge, the Belgrade wall time as UTC and the merchant', () => {
    expect(parseKoriscenjeKartice(buildKoriscenjeSms())).toEqual({
      kind: 'purchase',
      template: 'koriscenje-kartice',
      // 00:30 CEST is UTC+2.
      issuedAt: new Date('2026-09-14T22:30:00Z'),
      amountMinor: 600,
      currency: 'USD',
      description: 'EXAMPLE.COM',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
  });

  it('reads a winter date as CET, UTC+1', () => {
    expect(purchase(buildKoriscenjeSms({ datum: '15.01.2027 00:30:00' })).issuedAt).toEqual(
      new Date('2027-01-14T23:30:00Z'),
    );
  });

  it.each([
    ['6,00 USD', 600, 'USD'],
    ['1.234,56 RSD', 123456, 'RSD'],
    ['1234,56 RSD', 123456, 'RSD'],
    ['12.345.678,90 RSD', 1234567890, 'RSD'],
    ['1.500,00 JPY', 1500, 'JPY'],
  ] as const)('reads Iznos %s as %i %s', (iznos, amountMinor, currency) => {
    expect(purchase(buildKoriscenjeSms({ iznos }))).toMatchObject({ amountMinor, currency });
  });

  it('takes the amount from Iznos, never from the balance', () => {
    expect(purchase(buildKoriscenjeSms({ raspolozivo: '9.999,99 EUR' }))).toMatchObject({
      amountMinor: 600,
      currency: 'USD',
    });
  });

  it.each([
    ['EXAMPLE SHOP +381000000 RS', 'EXAMPLE SHOP'],
    ['KAFE 24 BEOGRAD RS', 'KAFE 24 BEOGRAD'],
    ['RS', 'RS'],
    ['  EXAMPLE   SHOP  RS ', 'EXAMPLE SHOP'],
  ])('describes Mesto %j as %j', (mesto, description) => {
    expect(purchase(buildKoriscenjeSms({ mesto })).description).toBe(description);
  });

  it('gives the same fingerprint with diacritics, CRLF line ends or blank lines', () => {
    const plain = purchase(buildKoriscenjeSms()).fingerprint;

    expect(
      purchase(buildKoriscenjeSms({ header: 'Korišćenje kartice 1234**5678' })).fingerprint,
    ).toBe(plain);
    expect(purchase(buildKoriscenjeSms({ lineEnd: '\r\n' })).fingerprint).toBe(plain);
    expect(purchase(`\n\n${buildKoriscenjeSms().replaceAll('\n', '\n\n')}\n\n`).fingerprint).toBe(
      plain,
    );
  });

  it('reads labels in any order, any case, with diacritics', () => {
    const text = [
      'KORIŠĆENJE KARTICE 1234**5678',
      'MESTO: EXAMPLE.COM +100000 NL',
      'Raspoloživo: 1.234,56 RSD',
      'iznos: 6,00 USD',
      'Datum: 15.09.2026 00:30:00',
    ].join('\n');

    expect(purchase(text).fingerprint).toBe(purchase(buildKoriscenjeSms()).fingerprint);
  });

  it('fingerprints a different purchase differently', () => {
    expect(purchase(buildKoriscenjeSms({ iznos: '7,00 USD' })).fingerprint).not.toBe(
      purchase(buildKoriscenjeSms()).fingerprint,
    );
  });

  it.each([
    ['a free-text expense', '450 кофе'],
    ['a receipt link', buildRsUrl()],
    ['kartice on the second line', 'Pozdrav\nKoriscenje kartice 1234**5678\nIznos: 6,00 USD'],
  ])('reads %s as notBankSms', (_name, text) => {
    expect(parseKoriscenjeKartice(text)).toEqual({ kind: 'notBankSms' });
    expect(parseBankSms(text)).toEqual({ kind: 'notBankSms' });
  });
});

describe('parseBankSms', () => {
  it('reads the Koriscenje kartice template', () => {
    expect(parseBankSms(buildKoriscenjeSms())).toEqual(
      parseKoriscenjeKartice(buildKoriscenjeSms()),
    );
  });
});
