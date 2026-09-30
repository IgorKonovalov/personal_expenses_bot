import { statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Liveness file for the Docker health check: the bot long-polls and has no HTTP port. A fresh
// file proves the event loop is alive after polling started, not that polling is healthy.
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MAX_AGE_MS = 120_000;

export interface Heartbeat {
  start(): void;
  stop(): void;
}

export function heartbeatPath(databasePath: string): string {
  return join(dirname(databasePath), 'heartbeat');
}

// Writes nothing until start(). A failed write is reported and retried on the next tick.
export function createHeartbeat(path: string, onError: (error: unknown) => void): Heartbeat {
  let timer: NodeJS.Timeout | undefined;
  const write = (): void => {
    try {
      writeFileSync(path, String(Date.now()));
    } catch (error) {
      onError(error);
    }
  };
  return {
    start() {
      if (timer !== undefined) return;
      write();
      timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

// 0 when the file was written within HEARTBEAT_MAX_AGE_MS of nowMs, else 1 (stale or missing).
export function heartbeatExitCode(path: string, nowMs: number): 0 | 1 {
  try {
    return nowMs - statSync(path).mtimeMs < HEARTBEAT_MAX_AGE_MS ? 0 : 1;
  } catch {
    return 1;
  }
}

// Health-check entry: `node dist/heartbeat.js <heartbeat file>`. The module has only node:
// imports and erasable syntax, so `node src/heartbeat.ts` runs the same check.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const path = process.argv[2];
  process.exit(path === undefined ? 1 : heartbeatExitCode(path, Date.now()));
}
