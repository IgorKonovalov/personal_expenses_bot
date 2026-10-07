import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Logger } from '../logger.js';
import type { Db } from './connection.js';

// Compressed backups (ADR-0044): an online copy, gzip-streamed to one dated file per UTC day,
// keeping the newest dailies plus the newest Sunday files.

export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Rotation owns only files matching this name, compressed or the uncompressed ones written
// before compression, which count as dailies by their date. Anything else is left alone.
const BACKUP_FILE = /^expenses-(\d{4}-\d{2}-\d{2})\.sqlite(?:\.gz)?$/;

export interface BackupRetention {
  // BACKUP_KEEP: the newest this many dates are kept.
  readonly keep: number;
  // BACKUP_KEEP_WEEKLY: the newest this many Sunday dates (UTC) are kept besides.
  readonly keepWeekly: number;
}

export interface BackupResult {
  readonly path: string;
  // The compressed file, and the copy it was compressed from.
  readonly bytes: number;
  readonly uncompressedBytes: number;
  readonly rotatedOut: readonly string[];
}

// The name carries the UTC date, so one file per UTC day.
export function backupFileName(at: Date): string {
  return `expenses-${utcDate(at)}.sqlite.gz`;
}

// How many days deleted data can survive in a backup, as /delete_account says: a daily lives
// `keep` days, and a Sunday's file until `keepWeekly` Sundays are newer.
export function backupRetentionDays(retention: BackupRetention): number {
  return Math.max(retention.keep, 7 * retention.keepWeekly);
}

// An online copy via SQLite's backup API into a temp file, gzip-streamed into a second temp name
// and renamed into place, so a reader never sees a half-written file; the uncompressed copy is
// removed. A same-day backup replaces the earlier one. Then rotation, then PRAGMA optimize.
export async function backupDatabase(
  db: Db,
  dir: string,
  retention: BackupRetention,
  at: Date,
): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, backupFileName(at));
  const copy = `${path}.copy.tmp`;
  const tmp = `${path}.tmp`;
  let uncompressedBytes: number;
  try {
    await db.backup(copy);
    uncompressedBytes = statSync(copy).size;
    await pipeline(createReadStream(copy), createGzip(), createWriteStream(tmp));
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  } finally {
    rmSync(copy, { force: true });
  }
  const rotatedOut = rotate(dir, retention);
  db.pragma('optimize');
  return { path, bytes: statSync(path).size, uncompressedBytes, rotatedOut };
}

// Deletes every backup file whose date is neither among the newest `keep` dates nor among the
// newest `keepWeekly` Sundays. A Sunday inside the daily window counts toward both. Returns the
// deleted paths, newest first.
function rotate(dir: string, retention: BackupRetention): string[] {
  const files = readdirSync(dir).flatMap((name) => {
    const date = BACKUP_FILE.exec(name)?.[1];
    return date === undefined ? [] : [{ name, date }];
  });
  const dates = [...new Set(files.map((file) => file.date))].sort().reverse();
  const kept = new Set([
    ...dates.slice(0, retention.keep),
    ...dates.filter(isSunday).slice(0, retention.keepWeekly),
  ]);
  const rotatedOut = files
    .filter((file) => !kept.has(file.date))
    .map((file) => file.name)
    .sort()
    .reverse()
    .map((name) => join(dir, name));
  for (const old of rotatedOut) rmSync(old, { force: true });
  return rotatedOut;
}

function isSunday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
}

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// Whether a backup for `at`'s UTC date is already in `dir`, compressed or not.
function hasBackupFor(dir: string, at: Date): boolean {
  const date = utcDate(at);
  return [`expenses-${date}.sqlite.gz`, `expenses-${date}.sqlite`].some((name) =>
    existsSync(join(dir, name)),
  );
}

export interface BackupSchedule {
  // Clears the timer and resolves once a backup in flight has settled, so the DB can close.
  stop(): Promise<void>;
}

export interface BackupScheduleDeps extends BackupRetention {
  readonly db: Db;
  readonly dir: string;
  readonly now: () => Date;
  readonly logger: Logger;
}

// One backup at boot unless today's file exists, then one every BACKUP_INTERVAL_MS. A failure is
// logged and never thrown: the bot keeps running and the next tick tries again. Log lines carry
// paths and sizes only.
export function startBackups(deps: BackupScheduleDeps): BackupSchedule {
  const { db, dir, now, logger } = deps;
  const retention = { keep: deps.keep, keepWeekly: deps.keepWeekly };
  let inFlight: Promise<void> = Promise.resolve();
  const run = (): void => {
    const at = now();
    const path = join(dir, backupFileName(at));
    inFlight = backupDatabase(db, dir, retention, at).then(
      (result) => {
        logger.info(
          { path: result.path, bytes: result.bytes, uncompressedBytes: result.uncompressedBytes },
          'backup written',
        );
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
  // A redeploy on the same UTC day keeps that day's backup instead of rewriting it.
  if (hasBackupFor(dir, now())) {
    logger.info({ path: join(dir, backupFileName(now())) }, 'backup exists for today');
  } else {
    run();
  }
  const timer = setInterval(run, BACKUP_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      return inFlight;
    },
  };
}
