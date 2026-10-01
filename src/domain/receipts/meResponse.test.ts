import { describe, expect, it } from 'vitest';
import { parseMeVerify } from './meResponse.js';

// A synthetic body in the shape of verifyInvoice's answer; no real receipt.
const BODY = `{"iic":"abcdef0123456789abcdef0123456789","totalPrice":42.5,"seller":{"idNum":"02000000","name":"Test Market"},"items":[{"name":"Hljeb","quantity":2,"priceAfterVat":2.4},{"name":"Sir","quantity":0.535,"priceAfterVat":40.10}]}`;

describe('parseMeVerify', () => {
  it('reads the seller, the total and the items in source order', () => {
    expect(parseMeVerify(BODY)).toEqual({
      sellerName: 'Test Market',
      totalMinor: 4250,
      items: [
        { name: 'Hljeb', quantity: '2', totalMinor: 240 },
        { name: 'Sir', quantity: '0.535', totalMinor: 4010 },
      ],
    });
  });

  it('passes on a currency code the site names', () => {
    const body = BODY.replace('"totalPrice"', '"currency":{"code":"USD"},"totalPrice"');

    expect(parseMeVerify(body)).toMatchObject({ currencyCode: 'USD' });
  });

  it.each([
    ['an empty body', ''],
    ['a line total with three fraction digits', BODY.replace('40.10', '40.105')],
    ['no seller', BODY.replace('"name":"Test Market"', '"x":1')],
  ])('refuses %s', (_name, body) => {
    expect(parseMeVerify(body)).toBeUndefined();
  });
});
