import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { jpegLuma, lumaToRgba, VARIANTS, type LumaRefusal, type Variant } from './qrPixels.js';

// QR decoding for receipt photos (ADR-0019): ZXing-C++ as WebAssembly, fed the JPEG/PNG bytes
// Telegram returns. By default the library downloads its .wasm from jsDelivr at first use; the
// binary is read from the installed package instead, so decoding never touches the network.
// A JPEG the plain pass reads no QR from is retried on preprocessed pixels (ADR-0034).

export type QrDecodeResult =
  // `pass` is 'plain' for the bytes as given, or the name of the variant that decoded.
  | { readonly kind: 'decoded'; readonly texts: readonly string[]; readonly pass: string }
  // No QR code was read, or the bytes aren't an image the decoder reads. `detected` describes the
  // largest symbol that was located but failed to decode, for the log; absent when none was.
  // `pixelDecode` is set when a JPEG's pixel decode was refused, so no retry variant ran.
  | {
      readonly kind: 'none';
      readonly detected?: QrDetected;
      readonly pixelDecode?: LumaRefusal;
    };

// A located QR symbol that didn't decode. Carries no decoded text, so it is safe to log.
export interface QrDetected {
  // The decoder's error kind, e.g. "ChecksumError" (modules misread past what the EC level
  // corrects) or "FormatError", without its source location.
  readonly error: string;
  readonly version: string;
  readonly ecLevel: string;
  // Image pixels per QR module along the top edge: below ~3 the modules blur into each other.
  readonly modulePx: number;
}

// No retry variant starts once this many milliseconds have passed since the first one started.
// A started variant runs to the end: the decode blocks the event loop and can't be interrupted.
export const QR_RETRY_BUDGET_MS = 1000;

// The retry list and the clock the budget is measured on; replaced only in tests.
export interface RetryOptions {
  readonly variants?: readonly Variant[];
  readonly now?: () => number;
}

let ready: Promise<unknown> | undefined;

// Instantiates the module once per process, on the first decode.
function prepare(): Promise<unknown> {
  ready ??= (async () => {
    const path = fileURLToPath(import.meta.resolve('zxing-wasm/reader/zxing_reader.wasm'));
    const wasm = await readFile(path);
    return prepareZXingModule({
      overrides: {
        wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
      },
      fireImmediately: true,
    });
  })();
  return ready;
}

type ReadResult = Awaited<ReturnType<typeof readBarcodes>>[number];

// Every QR text in the image, in the decoder's order.
export async function decodeQr(
  image: Uint8Array,
  { variants = VARIANTS, now = performance.now.bind(performance) }: RetryOptions = {},
): Promise<QrDecodeResult> {
  await prepare();
  const plain = await read(image);
  if (plain === undefined) return { kind: 'none' };
  const texts = validTexts(plain);
  if (texts.length > 0) return { kind: 'decoded', texts, pass: 'plain' };

  const pixels = isJpeg(image) ? jpegLuma(image) : undefined;
  if (pixels?.kind === 'luma') {
    const started = now();
    for (const variant of variants) {
      if (now() - started > QR_RETRY_BUDGET_MS) break;
      const retried = await read(lumaToRgba(variant.apply(pixels.luma)));
      const found = retried === undefined ? [] : validTexts(retried);
      if (found.length > 0) return { kind: 'decoded', texts: found, pass: variant.name };
    }
  }

  // The QRCode format filter still lets rMQR candidates through; their version isn't a number.
  const failed = plain
    .filter((r) => !r.isValid && r.format === 'QRCode')
    .sort((a, b) => edgePx(b) - edgePx(a))[0];
  return {
    kind: 'none',
    ...(failed === undefined ? {} : { detected: describe(failed) }),
    ...(pixels?.kind === 'refused' ? { pixelDecode: pixels.reason } : {}),
  };
}

// The decoder's results, or undefined for input it can't read as an image.
async function read(input: Parameters<typeof readBarcodes>[0]): Promise<ReadResult[] | undefined> {
  try {
    // returnErrors also yields the symbols that were located but failed, for `detected`.
    return await readBarcodes(input, {
      formats: ['QRCode'],
      tryHarder: true,
      returnErrors: true,
    });
  } catch {
    return undefined;
  }
}

function validTexts(results: readonly ReadResult[]): string[] {
  return results.filter((r) => r.isValid && r.text !== '').map((r) => r.text);
}

// The JPEG start-of-image marker, FF D8 FF. Other formats get only the plain pass.
function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function edgePx(r: ReadResult): number {
  const { topLeft, topRight } = r.position;
  return Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
}

function describe(r: ReadResult): QrDetected {
  // `extra` is the decoder's JSON metadata, e.g. {"Version":"23","ECLevel":"L",...}.
  let extra: { Version?: unknown; ECLevel?: unknown } = {};
  try {
    extra = JSON.parse(r.extra) as typeof extra;
  } catch {
    // Absent or malformed: the fields below fall back to empty.
  }
  const version = typeof extra.Version === 'string' ? extra.Version : '';
  // A version-V symbol is 17 + 4V modules wide.
  const modules = 17 + 4 * Number(version);
  return {
    error: r.error.split(' @')[0] ?? r.error,
    version,
    ecLevel: typeof extra.ECLevel === 'string' ? extra.ECLevel : '',
    modulePx: Number.isFinite(modules) ? Math.round((edgePx(r) / modules) * 10) / 10 : 0,
  };
}
