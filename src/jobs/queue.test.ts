import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_WAITING_JOBS,
  createJobQueue,
  forkRunner,
  type Job,
  type JobResult,
  type JobRunner,
} from './queue.js';

const QR: Job = { kind: 'qr', filePath: 'photos/a.jpg' };
const NONE: JobResult = { kind: 'qr', result: { kind: 'none' } };

// A runner whose jobs each wait for their own release.
function latched() {
  const releases: (() => void)[] = [];
  const started: Job[] = [];
  const run: JobRunner = (job) => {
    started.push(job);
    return new Promise<JobResult>((resolve) => {
      releases.push(() => {
        resolve(NONE);
      });
    });
  };
  const releaseNext = async () => {
    // Lets the queue reach the next job's run before releasing it.
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()?.();
  };
  return { run, started, releaseNext };
}

describe('createJobQueue', () => {
  it('runs one job at a time, holds 8 waiting, and refuses a 10th without running it', async () => {
    const { run, started, releaseNext } = latched();
    const queue = createJobQueue({ run, onError: () => undefined });
    const done: number[] = [];

    const answers = Array.from({ length: 10 }, (_, i) =>
      queue.enqueue({ kind: 'qr', filePath: `photos/${i}.jpg` }, () => {
        done.push(i);
        return Promise.resolve();
      }),
    );

    expect(MAX_WAITING_JOBS).toBe(8);
    expect(answers).toEqual([...Array<string>(9).fill('queued'), 'full']);
    expect(started).toHaveLength(1);
    for (let i = 0; i < 9; i++) await releaseNext();
    await queue.idle();
    expect(started).toHaveLength(9);
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('settles a job past the time limit as timeout, aborting it, and runs the next', async () => {
    let aborted = 0;
    const run: JobRunner = (job, signal) =>
      job.filePath === 'hang'
        ? new Promise<JobResult>(() => {
            signal.addEventListener('abort', () => {
              aborted += 1;
            });
          })
        : Promise.resolve(NONE);
    const queue = createJobQueue({ run, onError: () => undefined, timeoutMs: 100 });
    const results: JobResult[] = [];
    const record = (result: JobResult) => {
      results.push(result);
      return Promise.resolve();
    };

    queue.enqueue({ kind: 'qr', filePath: 'hang' }, record);
    queue.enqueue(QR, record);
    await queue.idle();

    expect(results).toEqual([{ kind: 'timeout' }, NONE]);
    expect(aborted).toBe(1);
  });

  it('settles a runner that rejects as failed with the class name only', async () => {
    const queue = createJobQueue({
      run: () => Promise.reject(new TypeError('secret detail')),
      onError: () => undefined,
    });
    const results: JobResult[] = [];

    queue.enqueue(QR, (result) => {
      results.push(result);
      return Promise.resolve();
    });
    await queue.idle();

    expect(results).toEqual([{ kind: 'failed', error: 'TypeError' }]);
  });

  it('reports a continuation that rejects and goes on with the next job', async () => {
    const errors: unknown[] = [];
    const queue = createJobQueue({
      run: () => Promise.resolve(NONE),
      onError: (error) => errors.push(error),
    });
    let second = false;

    queue.enqueue(QR, () => Promise.reject(new Error('boom')));
    queue.enqueue(QR, () => {
      second = true;
      return Promise.resolve();
    });
    await queue.idle();

    expect(errors).toHaveLength(1);
    expect(second).toBe(true);
  });
});

describe('forkRunner under the queue', () => {
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

  it('kills a child that never answers at a 100 ms limit, and the next job runs', async () => {
    // `hang` is never answered; any other name is served from the QR fixtures.
    const s = createServer((req, res) => {
      const name = (req.url ?? '').slice((req.url ?? '').lastIndexOf('/') + 1);
      if (name === 'hang') return;
      res.end(readFileSync(new URL(`../fiscal/qr.fixtures/${name}`, import.meta.url)));
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const fork = forkRunner({ download: { token: '123:secret', baseUrl } });
    // Records how each run ended: a killed child rejects with its exit signal. The job after
    // the hung one runs in this process, as a child's startup alone can take 100 ms.
    const ends: string[] = [];
    const run: JobRunner = (job, signal) =>
      (job.filePath === 'photos/hang' ? fork(job, signal) : Promise.resolve(NONE)).then(
        (result) => {
          ends.push('result');
          return result;
        },
        (error: unknown) => {
          ends.push(error instanceof Error ? error.message : 'NonError');
          throw error;
        },
      );
    const queue = createJobQueue({ run, onError: () => undefined, timeoutMs: 100 });
    const results: JobResult[] = [];
    const record = (result: JobResult) => {
      results.push(result);
      return Promise.resolve();
    };

    queue.enqueue({ kind: 'qr', filePath: 'photos/hang' }, record);
    queue.enqueue({ kind: 'qr', filePath: 'photos/example.png' }, record);
    await queue.idle();

    expect(results).toEqual([{ kind: 'timeout' }, NONE]);
    // The killed child's exit may land after the next job settled.
    await vi.waitFor(() => {
      expect([...ends].sort()).toEqual(['job child exited: SIGKILL', 'result']);
    });
  }, 30_000);
});
