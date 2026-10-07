import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { telegramFileDownloader } from './receipt.js';

describe('telegramFileDownloader', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const open = server;
    server = undefined;
    if (open === undefined) return;
    open.closeAllConnections();
    await new Promise<void>((resolve) =>
      open.close(() => {
        resolve();
      }),
    );
  });

  // Accepts every connection and never writes a byte back.
  async function silentServer(): Promise<string> {
    const s = createServer(() => {});
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it('rejects within the timeout when the server never answers', async () => {
    const baseUrl = await silentServer();
    const download = telegramFileDownloader('123:secret', { baseUrl, timeoutMs: 50 });

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
    const s = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const download = telegramFileDownloader('123:secret', { baseUrl, timeoutMs: 50 });

    const started = performance.now();
    await expect(download('photos/file_1.jpg')).rejects.toThrow('telegram file download failed');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
