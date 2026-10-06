// Measures decodeQr on the private corpus of real receipt photos in data/qr-corpus/ (gitignored,
// ADR-0034): `pnpm qr:corpus`. One line per image: the file name, the pass that decoded it or
// `none`, the located-but-unread symbol when there is one, `pixels <reason>` when the pixel decode
// was refused (so no retry variant ran), and the milliseconds. It never prints
// decoded text: the corpus is real receipts.
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeQr } from '../src/fiscal/qr.js';

const dir = join(import.meta.dirname, '..', 'data', 'qr-corpus');
const IMAGE = new Set(['.jpg', '.jpeg', '.png']);

const names = (await readdir(dir)).filter((n) => IMAGE.has(extname(n).toLowerCase())).sort();
let decoded = 0;
let slowest = 0;
for (const name of names) {
  const bytes = new Uint8Array(await readFile(join(dir, name)));
  const started = performance.now();
  const result = await decodeQr(bytes);
  const ms = Math.round(performance.now() - started);
  slowest = Math.max(slowest, ms);
  let pass = 'none';
  let detected = '';
  let pixels = '';
  if (result.kind === 'decoded') {
    decoded += 1;
    pass = result.pass;
  } else {
    const d = result.detected;
    if (d !== undefined)
      detected = `detected v${d.version} ${d.ecLevel} ${d.error} ${d.modulePx}px`;
    if (result.pixelDecode !== undefined) pixels = `pixels ${result.pixelDecode}`;
  }
  console.log([name, pass, detected, pixels, `${ms} ms`].filter((cell) => cell !== '').join('\t'));
}
console.log(`total: ${decoded} of ${names.length} decoded, slowest ${slowest} ms`);
