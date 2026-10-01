// Regenerates the synthetic QR fixtures qr.test.ts reads: `pnpm tsx src/fiscal/qr.fixtures/generate.ts`.
// Needs ImageMagick (`magick`). Every image encodes a synthetic URL; none is a photo of a receipt.
//
// - rs-receipt.jpg: the Serbian verify URL buildRsUrl() makes, at 4 px per module, rotated 1.7
//   degrees, noised and saved as JPEG q75 on a 1280 px canvas, roughly a Telegram photo.
// - rs-receipt-wrapped.jpg: the same treatment for buildRsUrl()'s link printed with a `:443`
//   host and the base64 wrapped every 76 characters by `%0A`, as some printers do.
// - example.png: a QR holding https://example.com, not a receipt.
// - no-qr.jpg: noise on a canvas, no barcode at all.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';
import { buildRsUrl } from '../../domain/receipts/testing/buildRsVl.js';

const here = fileURLToPath(new URL('./', import.meta.url));
const wasm = await readFile(
  fileURLToPath(import.meta.resolve('zxing-wasm/writer/zxing_writer.wasm')),
);
prepareZXingModule({
  overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
});

async function qrPng(text: string, path: string): Promise<void> {
  const result = await writeBarcode(text, { format: 'QRCode', scale: 1, options: 'ecLevel=M' });
  if (result.image === null) throw new Error(result.error);
  await writeFile(path, Buffer.from(await result.image.arrayBuffer()));
}

function magick(...args: string[]): void {
  execFileSync('magick', args, { stdio: 'inherit' });
}

// A receipt QR as a phone photographs it: 4 px per module, slightly rotated, noised, JPEG.
async function receiptPhoto(text: string, name: string): Promise<void> {
  const png = `${here}${name}.src.png`;
  await qrPng(text, png);
  magick(
    png,
    '-sample',
    '400%',
    '-background',
    'white',
    '-rotate',
    '1.7',
    '-gravity',
    'center',
    '-extent',
    '1280x1280',
    '-seed',
    '7',
    '-attenuate',
    '0.4',
    '+noise',
    'Gaussian',
    '-quality',
    '75',
    `${here}${name}.jpg`,
  );
  execFileSync('rm', [png]);
}

await receiptPhoto(buildRsUrl(), 'rs-receipt');
await receiptPhoto(buildRsUrl({}, { wrap: '%0A', port: true }), 'rs-receipt-wrapped');

const examplePng = `${here}example.src.png`;
await qrPng('https://example.com', examplePng);
magick(examplePng, '-sample', '800%', `${here}example.png`);
execFileSync('rm', [examplePng]);

magick(
  '-size',
  '640x640',
  'xc:white',
  '-seed',
  '7',
  '-attenuate',
  '0.6',
  '+noise',
  'Gaussian',
  '-quality',
  '75',
  `${here}no-qr.jpg`,
);
