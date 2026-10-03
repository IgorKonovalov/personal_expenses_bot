import { describe, expect, it } from 'vitest';
import { localMeanThreshold, luminance, type Luma } from './qrPixels.js';

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
