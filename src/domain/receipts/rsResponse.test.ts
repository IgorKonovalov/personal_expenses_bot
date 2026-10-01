import { describe, expect, it } from 'vitest';
import { parseRsSpecifications, parseRsToken, parseRsVerify } from './rsResponse.js';

// Synthetic bodies in the shape of the SUF answers; no real receipt.
const VERIFY = `{"isValid":true,"invoiceRequest":{"businessName":"Test Trgovina DOO","locationName":"Test Prodavnica 1"},"invoiceResult":{"invoiceNumber":"AAAA1111-AAAA1111-16898","totalAmount":829.12}}`;

function specifications(items: string): string {
  return `{"success":true,"items":[${items}]}`;
}

describe('parseRsVerify', () => {
  it('reads the location name, the total and the invoice number', () => {
    expect(parseRsVerify(VERIFY)).toEqual({
      sellerName: 'Test Prodavnica 1',
      totalMinor: 82912,
      invoiceNumber: 'AAAA1111-AAAA1111-16898',
    });
  });

  it('falls back to the business name', () => {
    const body = VERIFY.replace('"locationName":"Test Prodavnica 1"', '"locationName":""');

    expect(parseRsVerify(body)).toMatchObject({ sellerName: 'Test Trgovina DOO' });
  });

  it.each(['', '<html></html>', '{"isValid":false}'])('refuses %j', (body) => {
    expect(parseRsVerify(body)).toBeUndefined();
  });
});

describe('parseRsToken', () => {
  it("reads viewModel.Token('…') from the verify page", () => {
    expect(parseRsToken("<script>viewModel.Token('abc-123_x');</script>")).toBe('abc-123_x');
    expect(parseRsToken('<html></html>')).toBeUndefined();
  });
});

describe('parseRsSpecifications', () => {
  it('parses item totals from their source text and keeps the quantity as text', () => {
    const body = specifications(
      '{"name":"Hleb","quantity":0.535,"total":799.99},{"name":"Mleko","quantity":1,"total":29.13},{"name":"Kesa","quantity":1,"total":0.29}',
    );

    expect(parseRsSpecifications(body)).toEqual([
      { name: 'Hleb', quantity: '0.535', totalMinor: 79999 },
      { name: 'Mleko', quantity: '1', totalMinor: 2913 },
      { name: 'Kesa', quantity: '1', totalMinor: 29 },
    ]);
  });

  it('refuses a total with three fraction digits', () => {
    expect(
      parseRsSpecifications(specifications('{"name":"Hleb","quantity":1,"total":1.005}')),
    ).toBeUndefined();
  });

  it.each(['', 'null', '{"success":false}', specifications('')])('refuses %j', (body) => {
    expect(parseRsSpecifications(body)).toBeUndefined();
  });
});
