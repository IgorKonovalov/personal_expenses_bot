import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

// QR decoding for receipt photos (ADR-0019): ZXing-C++ as WebAssembly, fed the JPEG/PNG bytes
// Telegram returns. By default the library downloads its .wasm from jsDelivr at first use; the
// binary is read from the installed package instead, so decoding never touches the network.

export type QrDecodeResult =
  | { readonly kind: 'decoded'; readonly texts: readonly string[] }
  // No QR code was found, or the bytes aren't an image the decoder reads.
  | { readonly kind: 'none' };

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

// Every QR text in the image, in the decoder's order.
export async function decodeQr(image: Uint8Array): Promise<QrDecodeResult> {
  await prepare();
  let results;
  try {
    results = await readBarcodes(image, { formats: ['QRCode'], tryHarder: true });
  } catch {
    return { kind: 'none' };
  }
  const texts = results.filter((r) => r.isValid && r.text !== '').map((r) => r.text);
  return texts.length === 0 ? { kind: 'none' } : { kind: 'decoded', texts };
}
