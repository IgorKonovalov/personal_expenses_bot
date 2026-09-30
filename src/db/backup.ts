import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { Db } from './connection.js';

export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Rotation owns only files matching this name. Anything else in the directory is left alone.
const BACKUP_FILE = /^expenses-\d{4}-\d{2}-\d{2}\.sqlite$/;

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly rotatedOut: readonly string[];
}

// The name carries the UTC date, so one file per UTC day and rotation sorts by name alone.
export function backupFileName(at: Date): string {
  return `expenses-${at.toISOString().slice(0, 10)}.sqlite`;
}

// Online copy via SQLite's backup API into a temp name, renamed into place so a reader never sees
// a half-written file. A same-day backup replaces the earlier one. Then keeps the newest `keep`.
export async function backupDatabase(
  db: Db,
  dir: string,
  keep: number,
  at: Date,
): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, backupFileName(at));
  const tmp = `${path}.tmp`;
  try {
    await db.backup(tmp);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  const rotatedOut = readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort()
    .reverse()
    .slice(keep)
    .map((name) => join(dir, name));
  for (const old of rotatedOut) rmSync(old, { force: true });
  return { path, bytes: statSync(path).size, rotatedOut };
}

export interface BackupSchedule {
  // Clears the timer and resolves once a backup in flight has settled, so the DB can close.
  stop(): Promise<void>;
}

export interface BackupScheduleDeps {
  readonly db: Db;
  readonly dir: string;
  readonly keep: number;
  readonly now: () => Date;
  readonly logger: Logger;
}

// One backup now, then one every BACKUP_INTERVAL_MS. A failure is logged and never thrown: the bot
// keeps running and the next tick tries again. Log lines carry paths and sizes only.
export function startBackups(deps: BackupScheduleDeps): BackupSchedule {
  const { db, dir, keep, now, logger } = deps;
  let inFlight: Promise<void> = Promise.resolve();
  const run = (): void => {
    const at = now();
    const path = join(dir, backupFileName(at));
    inFlight = backupDatabase(db, dir, keep, at).then(
      (result) => {
        logger.info({ path: result.path, bytes: result.bytes }, 'backup written');
        for (const old of result.rotatedOut) logger.info({ path: old }, 'backup rotated out');
      },
      (error: unknown) => {
        logger.error(
          { path, err: error instanceof Error ? error.name : typeof error },
          'backup failed',
        );
      },
    );
  };
  run();
  const timer = setInterval(run, BACKUP_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      return inFlight;
    },
  };
}
