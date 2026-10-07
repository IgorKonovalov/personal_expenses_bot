import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { QrDecodeResult } from '../fiscal/qr.js';
import type { PdfText } from '../statements/pdf.js';
import type { ChildMessage, ChildRequest, DownloadSettings } from './child.js';

// The heavy-jobs adapter (ADR-0042): a receipt photo's QR decode and a statement PDF's text run
// here, one at a time, so the handler that enqueued one returns at once and no other update
// waits behind it. Each job runs in a freshly forked child (`forkRunner`) that exits after it.
// A job's continuation (`onDone`) runs in the bot process once the job settles, before the next
// job starts.

// Jobs waiting behind the running one; one more is refused.
export const MAX_WAITING_JOBS = 8;
// A job running this long is killed and settles as `timeout`.
export const JOB_TIMEOUT_MS = 20_000;

export type Job =
  | { readonly kind: 'qr'; readonly filePath: string }
  | { readonly kind: 'pdf'; readonly filePath: string; readonly maxPages: number };

export type JobResult =
  | { readonly kind: 'qr'; readonly result: QrDecodeResult }
  | { readonly kind: 'pdf'; readonly result: PdfText }
  | { readonly kind: 'timeout' }
  // The error's class name only, never its message or the file's content.
  | { readonly kind: 'failed'; readonly error: string };

// Runs one job. `signal` aborts at the time limit: the runner stops the work it started.
export type JobRunner = (job: Job, signal: AbortSignal) => Promise<JobResult>;

export interface JobQueue {
  // `full` when MAX_WAITING_JOBS are already waiting: the job is dropped and `onDone` never runs.
  enqueue(job: Job, onDone: (result: JobResult) => Promise<void>): 'queued' | 'full';
  // Resolves once nothing runs or waits and every continuation has settled: tests and shutdown.
  idle(): Promise<void>;
}

export interface JobQueueOptions {
  readonly run: JobRunner;
  // A continuation that rejects; the queue goes on with the next job.
  readonly onError: (error: unknown) => void;
  readonly timeoutMs?: number;
  readonly maxWaiting?: number;
}

export function createJobQueue(options: JobQueueOptions): JobQueue {
  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  const maxWaiting = options.maxWaiting ?? MAX_WAITING_JOBS;
  const waiting: { job: Job; onDone: (result: JobResult) => Promise<void> }[] = [];
  const idlers: (() => void)[] = [];
  let running = false;

  const runBounded = async (job: Job): Promise<JobResult> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<JobResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'timeout' });
      }, timeoutMs);
    });
    const ran = options.run(job, controller.signal).catch((error: unknown): JobResult => ({
      kind: 'failed',
      error: error instanceof Error ? error.name : 'NonError',
    }));
    try {
      return await Promise.race([ran, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  const drain = async (): Promise<void> => {
    running = true;
    for (let next = waiting.shift(); next !== undefined; next = waiting.shift()) {
      const result = await runBounded(next.job);
      try {
        await next.onDone(result);
      } catch (error) {
        options.onError(error);
      }
    }
    running = false;
    for (const resolve of idlers.splice(0)) resolve();
  };

  return {
    enqueue: (job, onDone) => {
      if (waiting.length >= maxWaiting) return 'full';
      waiting.push({ job, onDone });
      if (!running) void drain();
      return 'queued';
    },
    idle: () =>
      !running && waiting.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idlers.push(resolve);
          }),
  };
}

// The child's entry: compiled JavaScript next to this file in the image, the TypeScript source
// under tsx in dev and tests.
const SOURCE = import.meta.url.endsWith('.ts');
const CHILD_PATH = fileURLToPath(new URL(SOURCE ? './child.ts' : './child.js', import.meta.url));
const CHILD_EXEC_ARGV = SOURCE ? ['--import', 'tsx'] : ['--enable-source-maps'];

export interface ForkRunnerOptions {
  readonly download: DownloadSettings;
  // Fork to the child's `ready`, in ms: its startup cost.
  readonly onReady?: (ms: number) => void;
}

// Forks one child per job and kills it on abort. A child that exits without a result (a crash,
// an OOM kill) rejects, which the queue settles as `failed`.
export function forkRunner(options: ForkRunnerOptions): JobRunner {
  return (job, signal) =>
    new Promise<JobResult>((resolve, reject) => {
      const started = performance.now();
      const child = fork(CHILD_PATH, [], {
        serialization: 'advanced',
        execArgv: CHILD_EXEC_ARGV,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      let settled = false;
      const kill = () => {
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', kill, { once: true });
      child.on('message', (message: ChildMessage) => {
        if (message.kind === 'ready') {
          options.onReady?.(performance.now() - started);
          const request: ChildRequest = { job, download: options.download };
          child.send(request);
          return;
        }
        settled = true;
        resolve(message.result);
      });
      child.once('error', (error) => {
        if (!settled) reject(error);
      });
      child.once('exit', (code, exitSignal) => {
        signal.removeEventListener('abort', kill);
        if (!settled) reject(new Error(`job child exited: ${String(code ?? exitSignal)}`));
      });
    });
}
