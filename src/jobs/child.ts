import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeQr } from '../fiscal/qr.js';
import { readPdfLines } from '../statements/pdf.js';
import type { Job, JobResult } from './queue.js';

// The heavy-job child (ADR-0042): forked by the queue for one job, it says `ready`, takes the job
// and the download settings over IPC, downloads the file, runs `decodeQr` or `readPdfLines`,
// posts the result and exits, returning its memory. The bot token arrives over IPC only and is
// never logged; a failure is posted by its error class alone, never its message or the file's
// content.

// A download that never answers is bounded by this, headers and body together.
export const DOWNLOAD_TIMEOUT_MS = 30_000;

// Fetches a file by the path getFile returned. The URL carries the bot token, so neither it nor
// anything derived from it reaches an error message or a log.
export type FileDownloader = (filePath: string) => Promise<Uint8Array>;

export interface DownloadSettings {
  readonly token: string;
  // The Bot API host; tests point it at a local server.
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function telegramFileDownloader(settings: DownloadSettings): FileDownloader {
  const baseUrl = settings.baseUrl ?? 'https://api.telegram.org';
  const timeoutMs = settings.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  return async (filePath) => {
    // One signal for the request and the body read: it aborts both.
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/file/bot${settings.token}/${filePath}`, { signal });
    } catch {
      throw new Error('telegram file download failed');
    }
    if (!response.ok) throw new Error(`telegram file download failed: ${response.status}`);
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new Error('telegram file download failed');
    }
  };
}

// One job, in whatever process calls it: the child below, or the bot process in tests.
export async function runJob(job: Job, download: FileDownloader): Promise<JobResult> {
  try {
    const bytes = await download(job.filePath);
    return job.kind === 'qr'
      ? { kind: 'qr', result: await decodeQr(bytes) }
      : { kind: 'pdf', result: await readPdfLines(bytes, { maxPages: job.maxPages }) };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.name : 'NonError' };
  }
}

// What the queue sends the child, once it is ready.
export interface ChildRequest {
  readonly job: Job;
  readonly download: DownloadSettings;
}

// What the child sends the queue: `ready` once loaded, then the job's result.
export type ChildMessage =
  { readonly kind: 'ready' } | { readonly kind: 'done'; readonly result: JobResult };

function serve(send: (message: ChildMessage, done: () => void) => void): void {
  // The bot went away: nobody is waiting for the result.
  process.once('disconnect', () => process.exit(0));
  process.once('message', (request: ChildRequest) => {
    void runJob(request.job, telegramFileDownloader(request.download)).then((result) => {
      send({ kind: 'done', result }, () => process.exit(0));
    });
  });
  send({ kind: 'ready' }, () => undefined);
}

// Started as a forked child: this file is the entry script.
const entry = process.argv[1];
if (entry !== undefined && process.send !== undefined) {
  const self = fileURLToPath(import.meta.url);
  if (realpathSync(entry) === realpathSync(self)) {
    const send = process.send.bind(process);
    serve((message, done) => {
      send(message, undefined, {}, done);
    });
  }
}
