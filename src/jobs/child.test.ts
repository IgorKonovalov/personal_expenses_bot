import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeQr } from '../fiscal/qr.js';
import { telegramFileDownloader } from './child.js';
import { forkRunner } from './queue.js';

let server: Server | undefined;

afterEach(async () => {
  const open = server;
  server = undefined;
  if (open === undefined) return;
  open.closeAllConnections();
  await new Promise<void>((resolve) => {
    open.close(() => {
      resolve();
    });
  });
});

// A local stand-in for the Bot API's file host. Returns its base URL.
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`../fiscal/qr.fixtures/${name}`, import.meta.url));
}

describe('telegramFileDownloader', () => {
  it('rejects within the timeout when the server never answers', async () => {
    // Accepts every connection and never writes a byte back.
    const baseUrl = await serve(() => undefined);
    const download = telegramFileDownloader({ token: '123:secret', baseUrl, timeoutMs: 50 });

    const started = performance.now();
    const error = await download('photos/file_1.jpg').then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = performance.now() - started;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('telegram file download failed');
    expect(elapsed).toBeLessThan(1000);
  });

  it('rejects within the timeout when the body never finishes', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
    });
    const download = telegramFileDownloader({ token: '123:secret', baseUrl, timeoutMs: 50 });

    const started = performance.now();
    await expect(download('photos/file_1.jpg')).rejects.toThrow('telegram file download failed');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the forked child', () => {
  // Every fixture qr.test.ts decodes to a text.
  const DECODED = [
    'rs-receipt.jpg',
    'rs-receipt-wrapped.jpg',
    'example.png',
    'rs-receipt-dotgain.jpg',
  ];

  it('decodes every fixture qr.test.ts decodes to the same texts as decodeQr in this process', async () => {
    const baseUrl = await serve((req, res) => {
      const name = (req.url ?? '').slice((req.url ?? '').lastIndexOf('/') + 1);
      res.end(fixture(name));
    });
    const startups: number[] = [];
    const run = forkRunner({
      download: { token: '123:secret', baseUrl },
      onReady: (ms) => startups.push(ms),
    });

    for (const name of DECODED) {
      const inProcess = await decodeQr(fixture(name));
      const forked = await run(
        { kind: 'qr', filePath: `photos/${name}` },
        new AbortController().signal,
      );

      expect(inProcess.kind, name).toBe('decoded');
      expect(forked, name).toEqual({ kind: 'qr', result: inProcess });
    }
    // The startup cost Plan 0039 Phase 5 records: fork to ready, under tsx here.
    console.info(`job child startup: ${startups.map((ms) => Math.round(ms)).join(', ')} ms`);
    expect(startups).toHaveLength(DECODED.length);
  }, 60_000);

  it('posts a failed download by its error class, never the token or the URL', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(404).end();
    });
    const run = forkRunner({ download: { token: '123:secret', baseUrl } });

    const result = await run(
      { kind: 'qr', filePath: 'photos/gone.jpg' },
      new AbortController().signal,
    );

    expect(result).toEqual({ kind: 'failed', error: 'Error' });
  }, 30_000);
});
