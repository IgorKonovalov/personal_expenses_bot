import { readFileSync } from 'node:fs';
import { decode } from 'jpeg-js';
import { describe, expect, it, vi } from 'vitest';
import { jpegLuma, localMeanThreshold, luminance, type Luma } from './qrPixels.js';

// The JPEG decoder is wrapped in a spy, to read how it failed.
vi.mock('jpeg-js', async (importOriginal) => {
  const original = await importOriginal<typeof import('jpeg-js')>();
  return { ...original, decode: vi.fn(original.decode) };
});

function image(width: number, height: number, pixel: (x: number, y: number) => number): Luma {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data[y * width + x] = pixel(x, y);
  return { width, height, data };
}

describe('localMeanThreshold', () => {
  it('turns a constant mid-gray image all white', () => {
    const out = localMeanThreshold(
      image(40, 40, () => 128),
      31,
      3,
    );

    expect(out.data.every((v) => v === 255)).toBe(true);
  });

  it('keeps a 1-pixel dark dot on a white field black', () => {
    const out = localMeanThreshold(
      image(40, 40, (x, y) => (x === 20 && y === 20 ? 0 : 255)),
      31,
      3,
    );

    expect(out.data[20 * 40 + 20]).toBe(0);
    expect(out.data.filter((v) => v === 0)).toHaveLength(1);
  });

  it('thresholds a half-black, half-white 64x64 image to exactly the same split', () => {
    const src = image(64, 64, (x) => (x < 32 ? 0 : 255));

    const out = localMeanThreshold(src, 31, 3);

    expect(out).toEqual(src);
  });
});

describe('luminance', () => {
  it('is (299R + 587G + 114B) / 1000 rounded down: 76 for pure red', () => {
    expect(luminance(255, 0, 0)).toBe(76);
  });
});

describe('jpegLuma', () => {
  it('returns undefined for a header claiming 20000x20000, refused before the pixels', () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./qr.fixtures/rs-receipt.jpg', import.meta.url)),
    );
    // The baseline frame header (FF C0) at byte 89: height at +5, width at +7, big-endian.
    expect([bytes[89], bytes[90]]).toEqual([0xff, 0xc0]);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(89 + 5, 20000);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(89 + 7, 20000);
    vi.mocked(decode).mockClear();

    expect(jpegLuma(bytes)).toBeUndefined();

    const outcome = vi.mocked(decode).mock.results[0];
    expect(outcome?.type).toBe('throw');
    expect(String(outcome?.value)).toMatch(/maxResolutionInMP limit exceeded/);
  });
});
