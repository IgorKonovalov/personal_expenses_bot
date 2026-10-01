import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRsUrl } from '../domain/receipts/testing/buildRsVl.js';
import { decodeQr } from './qr.js';

function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`./qr.fixtures/${name}`, import.meta.url));
}

describe('decodeQr', () => {
  // The wasm must come from node_modules: any fetch, e.g. to jsDelivr, fails the test.
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = () => {
      throw new Error('decodeQr reached the network');
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it('decodes the synthetic Serbian receipt JPEG to exactly its URL, offline', async () => {
    const image = fixture('rs-receipt.jpg');
    const started = performance.now();

    const result = await decodeQr(image);

    // The decode time ADR-0019 asks for; read from the test output.
    console.info(`rs-receipt.jpg decoded in ${Math.round(performance.now() - started)} ms`);
    expect(result).toEqual({ kind: 'decoded', texts: [buildRsUrl()] });
  });

  it('decodes a QR that is not a receipt to its text', async () => {
    expect(await decodeQr(fixture('example.png'))).toEqual({
      kind: 'decoded',
      texts: ['https://example.com'],
    });
  });

  it('returns none for an image without a QR code', async () => {
    expect(await decodeQr(fixture('no-qr.jpg'))).toEqual({ kind: 'none' });
  });

  it('returns none for bytes that are not an image', async () => {
    expect(await decodeQr(new TextEncoder().encode('not an image'))).toEqual({ kind: 'none' });
  });
});
