import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { SEND_GAP_MS } from '../bot/scheduledSender.js';
import { CATCH_UP_MS } from '../services/periodReport.js';
import { MAX_FIRES_PER_TICK, register, type Provider } from './types.js';
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

describe('the per-tick cap (ADR-0043)', () => {
  // Occurrences that stay due until fired, as a claimed push stops being due.
  function claiming(name: string, count: number) {
    const pending = new Set(Array.from({ length: count }, (_, i) => i));
    const firedPerTick: number[] = [];
    let firedThisTick = 0;
    const provider: Provider<number> = {
      name,
      due: () => {
        firedThisTick = 0;
        firedPerTick.push(0);
        return [...pending];
      },
      fire: (occurrence) => {
        pending.delete(occurrence);
        firedThisTick += 1;
        firedPerTick[firedPerTick.length - 1] = firedThisTick;
        return Promise.resolve();
      },
    };
    return { provider, firedPerTick };
  }

  it('fires 450 due summaries as 200, 200 and 50, and a recurring one in the first tick', async () => {
    const summary = claiming('summary', 450);
    const recurring = claiming('recurring', 1);
    const providers = [register(recurring.provider), register(summary.provider)];
    const now = new Date('2026-11-01T08:00:00Z');

    for (let i = 0; i < 4; i += 1) await runTick({ logger: silent(), providers }, now);

    expect(summary.firedPerTick).toEqual([200, 200, 50, 0]);
    expect(recurring.firedPerTick).toEqual([1, 0, 0, 0]);
    expect(MAX_FIRES_PER_TICK).toBe(200);
  });

  it('drains 10,000 pushes in 50 ticks of at least 8 s of paced sends, inside CATCH_UP_MS', () => {
    const ticks = Math.ceil(10_000 / MAX_FIRES_PER_TICK);
    const sendMsPerTick = MAX_FIRES_PER_TICK * SEND_GAP_MS;

    expect(ticks).toBe(50);
    expect(sendMsPerTick).toBe(8_000);
    // A tick overlapping the next minute delays it; each tick then takes the longer of the two.
    const totalMs = ticks * Math.max(TICK_MS, sendMsPerTick);
    expect(totalMs).toBe(50 * 60_000);
    expect(totalMs).toBeLessThan(CATCH_UP_MS);
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
