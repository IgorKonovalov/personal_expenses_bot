import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeartbeat, heartbeatPath } from './heartbeat.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heartbeat-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('heartbeat', () => {
  it('lives next to the database file', () => {
    expect(heartbeatPath('/app/data/bot.sqlite')).toBe('/app/data/heartbeat');
  });

  it('writes nothing before start, rewrites every 30 s, and stops writing after stop', () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T10:00:00Z') });
    const path = heartbeatPath(join(dir, 'bot.sqlite'));
    const heartbeat = createHeartbeat(path, () => {
      throw new Error('unexpected write failure');
    });

    vi.advanceTimersByTime(60_000);
    expect(existsSync(path)).toBe(false);

    heartbeat.start();
    const started = Date.parse('2026-09-29T10:01:00Z');
    expect(readFileSync(path, 'utf8')).toBe(String(started));

    vi.advanceTimersByTime(30_000);
    expect(readFileSync(path, 'utf8')).toBe(String(started + 30_000));

    heartbeat.stop();
    vi.advanceTimersByTime(60_000);
    expect(readFileSync(path, 'utf8')).toBe(String(started + 30_000));
  });

  it('reports a failed write instead of throwing', () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const heartbeat = createHeartbeat(join(dir, 'missing', 'heartbeat'), (error) => {
      errors.push(error);
    });
    heartbeat.start();
    vi.advanceTimersByTime(30_000);
    heartbeat.stop();
    expect(errors).toHaveLength(2);
  });
});

describe('health-check command', () => {
  const script = fileURLToPath(new URL('./heartbeat.ts', import.meta.url));
  const check = (path: string): number | null =>
    spawnSync(process.execPath, [script, path], { encoding: 'utf8' }).status;
  const writeAged = (path: string, ageSeconds: number): void => {
    writeFileSync(path, 'x');
    const at = (Date.now() - ageSeconds * 1000) / 1000;
    utimesSync(path, at, at);
  };

  it('exits 0 for a heartbeat 119 s old', () => {
    const path = join(dir, 'heartbeat');
    writeAged(path, 119);
    expect(check(path)).toBe(0);
  });

  it('exits 1 for a heartbeat 121 s old', () => {
    const path = join(dir, 'heartbeat');
    writeAged(path, 121);
    expect(check(path)).toBe(1);
  });

  it('exits 1 when the heartbeat is missing', () => {
    expect(check(join(dir, 'heartbeat'))).toBe(1);
  });
});
