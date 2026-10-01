import { describe, expect, it } from 'vitest';
import { decodeMeUrl } from '../domain/receipts/meUrl.js';
import { createMeFetcher } from './meFetcher.js';

// A synthetic verifyInvoice answer, served by an injected fetch: nothing reaches the network.
const BODY = `{"totalPrice":42.5,"seller":{"name":"Test Market"},"items":[{"name":"Hljeb","quantity":2,"priceAfterVat":2.4},{"name":"Sir","quantity":0.535,"priceAfterVat":40.1}]}`;

function verifyUrl(): string {
  const decoded = decodeMeUrl(
    'https://mapr.tax.gov.me/ic/#/verify?iic=ABCDEF0123456789abcdef0123456789&tin=02000000&crtd=2026-09-30T23:15:00+02:00&prc=42.50&bu=ab123cd456',
  );
  if (decoded.kind !== 'receipt') throw new Error('synthetic receipt did not decode');
  return decoded.receipt.verifyUrl;
}

describe('createMeFetcher', () => {
  it('posts the iic, creation instant and tin, and reads the seller and items', async () => {
    const seen: { url: string; method: string | undefined; body: unknown }[] = [];
    const fetcher = createMeFetcher((input, init) => {
      seen.push({
        url: String(input instanceof Request ? input.url : input),
        method: init?.method,
        body: init?.body,
      });
      return Promise.resolve(new Response(BODY));
    });

    const outcome = await fetcher(
      { verifyUrl: verifyUrl(), fiscalId: 'x' },
      new AbortController().signal,
    );

    expect(outcome).toEqual({
      kind: 'fetched',
      receipt: {
        sellerName: 'Test Market',
        totalMinor: 4250,
        items: [
          { name: 'Hljeb', quantity: '2', totalMinor: 240 },
          { name: 'Sir', quantity: '0.535', totalMinor: 4010 },
        ],
      },
    });
    expect(seen).toEqual([
      {
        url: 'https://mapr.tax.gov.me/ic/api/verifyInvoice',
        method: 'POST',
        body: new URLSearchParams({
          iic: 'abcdef0123456789abcdef0123456789',
          dateTimeCreated: '2026-09-30T23:15:00+02:00',
          tin: '02000000',
        }).toString(),
      },
    ]);
  });

  it('fails on a non-2xx status', async () => {
    const fetcher = createMeFetcher(() => Promise.resolve(new Response('x', { status: 500 })));

    expect(
      await fetcher({ verifyUrl: verifyUrl(), fiscalId: 'x' }, new AbortController().signal),
    ).toEqual({ kind: 'failed', reason: 'http' });
  });
});
