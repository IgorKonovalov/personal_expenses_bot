import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { register, type Provider } from './types.js';
import { TICK_MS, runTick, startScheduler } from './worker.js';

function silent() {
  return createLogger('silent');
}

function counting(due: readonly number[], fail?: number) {
  const fired: { occurrence: number; now: Date }[] = [];
  const provider: Provider<number> = {
    name: 'test',
    due: () => due,
    fire: (occurrence, now) => {
      if (occurrence === fail) return Promise.reject(new Error('boom'));
      fired.push({ occurrence, now });
      return Promise.resolve();
    },
  };
  return { provider, fired };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runTick', () => {
  it('fires every due occurrence at the tick time', async () => {
    const { provider, fired } = counting([1, 2]);
    const now = new Date('2026-11-01T08:00:00Z');

    await runTick({ logger: silent(), providers: [register(provider)] }, now);

    expect(fired).toEqual([
      { occurrence: 1, now },
      { occurrence: 2, now },
    ]);
  });

  it('keeps firing after one occurrence throws, and logs the provider without the error text', async () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) });
    const { provider, fired } = counting([1, 2, 3], 2);

    await runTick({ logger, providers: [register(provider)] }, new Date());

    expect(fired.map((f) => f.occurrence)).toEqual([1, 3]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ provider: 'test', err: 'Error' });
    expect(lines[0]).not.toContain('boom');
  });
});

describe('startScheduler', () => {
  it('ticks at start, then every 60 seconds, and not after stop', async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const provider: Provider<number> = {
      name: 'test',
      due: () => {
        ticks += 1;
        return [];
      },
      fire: () => Promise.resolve(),
    };
    const scheduler = startScheduler({
      logger: silent(),
      now: () => new Date(),
      providers: [register(provider)],
    });
    expect(ticks).toBe(1);

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(ticks).toBe(2);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(TICK_MS * 3);
    expect(ticks).toBe(2);
  });

  it('skips a tick while one is in flight', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    let fires = 0;
    const provider: Provider<number> = {
      name: 'test',
      due: () => [1],
      fire: () => {
        fires += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const scheduler = startScheduler({
      logger: silent(),
      now: () => new Date(),
      providers: [register(provider)],
    });

    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(fires).toBe(1);

    release();
    await scheduler.stop();
  });
});
