import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { decode } from 'jpeg-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBarcodes } from 'zxing-wasm/reader';
import { buildRsUrl } from '../domain/receipts/testing/buildRsVl.js';
import { decodeQr, QR_RETRY_BUDGET_MS } from './qr.js';
import { VARIANTS, type Variant } from './qrPixels.js';

// The JPEG decoder is wrapped in a spy, to tell which inputs reach the pixel retries.
vi.mock('jpeg-js', async (importOriginal) => {
  const original = await importOriginal<typeof import('jpeg-js')>();
  return { ...original, decode: vi.fn(original.decode) };
});

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
  beforeEach(() => {
    vi.mocked(decode).mockClear();
  });

  it('decodes the synthetic Serbian receipt JPEG to exactly its URL, offline', async () => {
    const image = fixture('rs-receipt.jpg');
    const started = performance.now();

    const result = await decodeQr(image);

    // The decode time ADR-0019 asks for; read from the test output.
    console.info(`rs-receipt.jpg decoded in ${Math.round(performance.now() - started)} ms`);
    expect(result).toEqual({ kind: 'decoded', texts: [buildRsUrl()], pass: 'plain' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('decodes the wrapped :443 Serbian receipt JPEG to exactly its URL', async () => {
    const text = buildRsUrl({}, { wrap: '%0A', port: true });
    expect(text).toMatch(/^https:\/\/suf\.purs\.gov\.rs:443\/v\/\?vl=/);
    expect(text).toContain('%0A');

    expect(await decodeQr(fixture('rs-receipt-wrapped.jpg'))).toEqual({
      kind: 'decoded',
      texts: [text],
      pass: 'plain',
    });
  });

  it('decodes a QR that is not a receipt to its text, a PNG on the plain pass', async () => {
    expect(await decodeQr(fixture('example.png'))).toEqual({
      kind: 'decoded',
      texts: ['https://example.com'],
      pass: 'plain',
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it('reads no valid QR from the dot-gain fixture on the plain pass', async () => {
    await decodeQr(fixture('no-qr.jpg')); // instantiates the wasm module offline

    const results = await readBarcodes(fixture('rs-receipt-dotgain.jpg'), {
      formats: ['QRCode'],
      tryHarder: true,
      returnErrors: true,
    });

    expect(results.filter((r) => r.isValid)).toEqual([]);
  });

  it('decodes the dot-gain fixture to exactly its URL on the first retry variant', async () => {
    expect(await decodeQr(fixture('rs-receipt-dotgain.jpg'))).toEqual({
      kind: 'decoded',
      texts: [buildRsUrl()],
      pass: VARIANTS[0]?.name,
    });
    expect(VARIANTS[0]?.name).toBe('blur3-lmt21-3');
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('starts no variant once the retry budget has passed, and returns none', async () => {
    let clock = 0;
    const first: Variant = {
      name: 'first',
      apply: (src) => {
        clock += QR_RETRY_BUDGET_MS + 1;
        return src;
      },
    };
    const second = { name: 'second', apply: vi.fn((src: Parameters<Variant['apply']>[0]) => src) };

    const result = await decodeQr(fixture('no-qr.jpg'), {
      variants: [first, second],
      now: () => clock,
    });

    expect(result).toEqual({ kind: 'none' });
    expect(second.apply).not.toHaveBeenCalled();
  });

  it('runs the next variant while the retry budget lasts', async () => {
    let clock = 0;
    const first: Variant = {
      name: 'first',
      apply: (src) => {
        clock += QR_RETRY_BUDGET_MS;
        return src;
      },
    };
    const second = { name: 'second', apply: vi.fn((src: Parameters<Variant['apply']>[0]) => src) };

    await decodeQr(fixture('no-qr.jpg'), { variants: [first, second], now: () => clock });

    expect(second.apply).toHaveBeenCalledTimes(1);
  });

  it('returns none for a JPEG header claiming 20000x20000, refused by the pixel decode', async () => {
    const bytes = new Uint8Array(fixture('rs-receipt.jpg'));
    // The baseline frame header (FF C0) at byte 89: height at +5, width at +7, big-endian.
    expect([bytes[89], bytes[90]]).toEqual([0xff, 0xc0]);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(89 + 5, 20000);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(89 + 7, 20000);

    expect(await decodeQr(bytes)).toEqual({ kind: 'none' });
    const outcome = vi.mocked(decode).mock.results[0];
    expect(outcome?.type).toBe('throw');
    expect(String(outcome?.value)).toMatch(/maxResolutionInMP limit exceeded/);
  });

  it('describes a located QR that fails its checksum, without its text', async () => {
    expect(await decodeQr(fixture('rs-receipt-damaged.jpg'))).toEqual({
      kind: 'none',
      detected: { error: 'ChecksumError', version: '23', ecLevel: 'M', modulePx: 4 },
    });
  });

  it('returns none for an image without a QR code', async () => {
    expect(await decodeQr(fixture('no-qr.jpg'))).toEqual({ kind: 'none' });
  });

  it('returns none for bytes that are not an image, without the pixel decoder', async () => {
    expect(await decodeQr(new TextEncoder().encode('not an image'))).toEqual({ kind: 'none' });
    expect(decode).not.toHaveBeenCalled();
  });
});
