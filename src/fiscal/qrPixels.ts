import { decode } from 'jpeg-js';

// Pixel preprocessing for receipt photos the plain QR pass can't read (ADR-0034): the JPEG is
// decoded to luminance with jpeg-js, and each variant is a pure function from one luminance
// image to another, retried through ZXing in order.

// One byte of luminance per pixel, row-major.
export interface Luma {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface Variant {
  readonly name: string;
  apply(src: Luma): Luma;
}

// BT.601 luma in integer arithmetic, rounded down: (299R + 587G + 114B) / 1000.
export function luminance(r: number, g: number, b: number): number {
  return Math.floor((299 * r + 587 * g + 114 * b) / 1000);
}

// The pixel decode's limits. A Telegram photo is at most 2560 px on its long side (3.7 MP); a
// larger image sent as a file still gets the plain pass, only not the retries. At 8 MP the
// decoder's own buffers stay under 64 MB, and a retry's peak (the RGBA output, the Float64
// integral image, two luminance buffers) stays near 130 MB against the container's 256 MiB.
export const MAX_RESOLUTION_MP = 8;
export const MAX_MEMORY_MB = 64;

// Decodes a JPEG to luminance, or undefined for bytes jpeg-js can't decode (not a JPEG, a
// truncated file, an unsupported encoding) or that exceed the limits above. jpeg-js checks the
// resolution from the frame header before it allocates the pixels.
export function jpegLuma(bytes: Uint8Array): Luma | undefined {
  let rgba;
  try {
    rgba = decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_RESOLUTION_MP,
      maxMemoryUsageInMB: MAX_MEMORY_MB,
    });
  } catch {
    return undefined;
  }
  const { width, height, data: src } = rgba;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = luminance(src[4 * i] ?? 0, src[4 * i + 1] ?? 0, src[4 * i + 2] ?? 0);
  }
  return { width, height, data };
}

// The grey RGBA image ZXing reads in place of ImageData.
export function lumaToRgba(src: Luma): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const data = new Uint8ClampedArray(src.width * src.height * 4);
  for (let i = 0; i < src.data.length; i++) {
    const v = src.data[i] ?? 0;
    data[4 * i] = v;
    data[4 * i + 1] = v;
    data[4 * i + 2] = v;
    data[4 * i + 3] = 255;
  }
  return { data, width: src.width, height: src.height };
}

// Summed-area table: entry (x, y) of the (width + 1) x (height + 1) table holds the sum of every
// pixel above and left of (x, y). Float64 keeps the sums exact past 2^32 on large photos.
function integral(src: Luma): Float64Array {
  const w = src.width + 1;
  const table = new Float64Array(w * (src.height + 1));
  for (let y = 0; y < src.height; y++) {
    let row = 0;
    for (let x = 0; x < src.width; x++) {
      row += src.data[y * src.width + x] ?? 0;
      table[(y + 1) * w + x + 1] = (table[y * w + x + 1] ?? 0) + row;
    }
  }
  return table;
}

// Sum and pixel count of the square of the given radius around (x, y), clipped to the image.
function windowSum(
  table: Float64Array,
  src: Luma,
  x: number,
  y: number,
  radius: number,
): { sum: number; count: number } {
  const w = src.width + 1;
  const x0 = Math.max(0, x - radius);
  const y0 = Math.max(0, y - radius);
  const x1 = Math.min(src.width, x + radius + 1);
  const y1 = Math.min(src.height, y + radius + 1);
  const sum =
    (table[y1 * w + x1] ?? 0) -
    (table[y0 * w + x1] ?? 0) -
    (table[y1 * w + x0] ?? 0) +
    (table[y0 * w + x0] ?? 0);
  return { sum, count: (x1 - x0) * (y1 - y0) };
}

// Mean of the 3x3 neighbourhood (clipped at the edges), rounded down.
export function boxBlur3(src: Luma): Luma {
  const table = integral(src);
  const data = new Uint8Array(src.data.length);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const { sum, count } = windowSum(table, src, x, y, 1);
      data[y * src.width + x] = Math.floor(sum / count);
    }
  }
  return { width: src.width, height: src.height, data };
}

// A pixel turns white (255) when it is brighter than the mean of its window x window
// neighbourhood lowered by offsetPercent of that mean, and black (0) otherwise. The comparison is
// strict and relative to the mean, so a uniform dark area stays black and a uniform lighter one
// turns white. The window is clipped at the image edges.
export function localMeanThreshold(src: Luma, window: number, offsetPercent: number): Luma {
  const table = integral(src);
  const radius = Math.floor(window / 2);
  const keep = 100 - offsetPercent;
  const data = new Uint8Array(src.data.length);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = y * src.width + x;
      const { sum, count } = windowSum(table, src, x, y, radius);
      // pixel > mean * keep / 100, kept in integers.
      data[i] = 100 * (src.data[i] ?? 0) * count > keep * sum ? 255 : 0;
    }
  }
  return { width: src.width, height: src.height, data };
}

// The retry variants, tried in order after the plain pass. Each one is kept only while it decodes
// a photo in the private corpus that no earlier variant decodes, as measured by `pnpm qr:corpus`.
export const VARIANTS: readonly Variant[] = [
  {
    name: 'blur3-lmt21-3',
    apply: (src) => localMeanThreshold(boxBlur3(src), 21, 3),
  },
];
