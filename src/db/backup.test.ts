import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { BACKUP_INTERVAL_MS, backupDatabase, backupRetentionDays, startBackups } from './backup.js';
import { openDatabase, type Db } from './connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from './expenses.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

// 22:30 UTC is already 30 September in Belgrade: backup names follow the UTC date.
const AT = new Date('2026-09-29T22:30:00Z');
const USER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;
const DEFAULTS = { keep: 7, keepWeekly: 4 };

let tmp: string;
let dir: string;
let db: Db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'backup-'));
  dir = join(tmp, 'backups');
  db = openDatabase(join(tmp, 'bot.sqlite'));
  runMigrations(db, AT);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: AT });
  insertLedger(db, {
    id: LEDGER,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RSD',
    ownerUserId: USER,
    createdAt: AT,
  });
  insertMember(db, { ledgerId: LEDGER, userId: USER, role: 'owner' });
  for (const n of [1, 2, 3]) {
    insertExpenseOrGetExisting(db, {
      id: `expense-${n}` as ExpenseId,
      ledgerId: LEDGER,
      createdBy: USER,
      amountMinor: 45000 * n,
      currency: 'RSD',
      description: 'coffee',
      occurredAt: AT,
      occurredOn: '2026-09-30' as LocalDate,
      sourceKey: `source-${n}`,
      createdAt: AT,
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

let restores = 0;

// The expense rows of a compressed backup, gunzipped to a file and opened as SQLite.
function backupExpenses(path: string): unknown[] {
  const restored = join(tmp, `restored-${String(++restores)}.sqlite`);
  writeFileSync(restored, gunzipSync(readFileSync(path)));
  const copy = new Database(restored, { readonly: true });
  try {
    return copy.prepare('SELECT * FROM expenses ORDER BY id').all();
  } finally {
    copy.close();
  }
}

describe('backupDatabase', () => {
  it('writes a gzip file named after the UTC date that opens to the same expense rows', async () => {
    const result = await backupDatabase(db, dir, DEFAULTS, AT);

    const path = join(dir, 'expenses-2026-09-29.sqlite.gz');
    expect(result.path).toBe(path);
    expect(result.bytes).toBe(statSync(path).size);
    expect(result.uncompressedBytes).toBeGreaterThan(result.bytes);
    const source = db.prepare('SELECT * FROM expenses ORDER BY id').all();
    expect(source).toHaveLength(3);
    expect(backupExpenses(path)).toEqual(source);
  });

  it('replaces a same-day backup and leaves no temp file', async () => {
    await backupDatabase(db, dir, DEFAULTS, AT);
    db.prepare('DELETE FROM expenses WHERE id = ?').run('expense-3');
    await backupDatabase(db, dir, DEFAULTS, new Date('2026-09-29T23:59:00Z'));

    expect(readdirSync(dir)).toEqual(['expenses-2026-09-29.sqlite.gz']);
    expect(backupExpenses(join(dir, 'expenses-2026-09-29.sqlite.gz'))).toHaveLength(2);
  });

  it('keeps 7 dailies and the 4 newest Sundays after daily backups from 1 August to 7 October', async () => {
    for (
      let day = new Date('2026-08-01T03:00:00Z');
      day <= new Date('2026-10-07T03:00:00Z');
      day = new Date(day.getTime() + BACKUP_INTERVAL_MS)
    ) {
      await backupDatabase(db, dir, DEFAULTS, day);
    }

    expect(readdirSync(dir).sort()).toEqual(
      [
        '2026-09-13',
        '2026-09-20',
        '2026-09-27',
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
      ].map((date) => `expenses-${date}.sqlite.gz`),
    );
  });

  it('counts uncompressed files as dailies by date, and ignores other names', async () => {
    mkdirSync(dir, { recursive: true });
    // 16 to 28 September: 13 days, Sundays the 20th and the 27th.
    const legacy = Array.from(
      { length: 13 },
      (_, i) => `expenses-2026-09-${String(16 + i)}.sqlite`,
    );
    for (const name of [...legacy, 'notes.txt', 'expenses-manual.sqlite']) {
      writeFileSync(join(dir, name), 'x');
    }

    const result = await backupDatabase(db, dir, { keep: 3, keepWeekly: 1 }, AT);

    expect(readdirSync(dir).sort()).toEqual(
      [
        'expenses-2026-09-27.sqlite',
        'expenses-2026-09-28.sqlite',
        'expenses-2026-09-29.sqlite.gz',
        'expenses-manual.sqlite',
        'notes.txt',
      ].sort(),
    );
    expect(result.rotatedOut).toEqual(
      legacy
        .filter((name) => !name.includes('09-27') && !name.includes('09-28'))
        .reverse()
        .map((name) => join(dir, name)),
    );
  });

  it('creates a missing directory with mode 0700', async () => {
    expect(existsSync(dir)).toBe(false);
    await backupDatabase(db, dir, DEFAULTS, AT);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('backupRetentionDays', () => {
  it('is 28 days with the defaults: four weekly Sundays outlast seven dailies', () => {
    expect(backupRetentionDays(DEFAULTS)).toBe(28);
    expect(backupRetentionDays({ keep: 30, keepWeekly: 4 })).toBe(30);
    expect(backupRetentionDays({ keep: 7, keepWeekly: 0 })).toBe(7);
  });
});

describe('startBackups', () => {
  function capture(): {
    lines: Record<string, unknown>[];
    logger: ReturnType<typeof createLogger>;
  } {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger('info', {
      write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    return { lines, logger };
  }

  it('backs up at boot and again 24 h later', async () => {
    // better-sqlite3 steps a backup via setImmediate, so only the interval and the clock are fake.
    vi.useFakeTimers({ now: AT, toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { lines, logger } = capture();
    const schedule = startBackups({ db, dir, ...DEFAULTS, now: () => new Date(), logger });

    await vi.waitFor(() => {
      expect(lines.filter((l) => l.msg === 'backup written')).toHaveLength(1);
    });
    expect(readdirSync(dir)).toEqual(['expenses-2026-09-29.sqlite.gz']);

    vi.advanceTimersByTime(BACKUP_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(lines.filter((l) => l.msg === 'backup written')).toHaveLength(2);
    });
    await schedule.stop();

    expect(readdirSync(dir).sort()).toEqual([
      'expenses-2026-09-29.sqlite.gz',
      'expenses-2026-09-30.sqlite.gz',
    ]);
    const path = join(dir, 'expenses-2026-09-30.sqlite.gz');
    // Beyond pino's own keys, the line carries the path and the sizes only.
    const { level, time, pid, hostname, msg, ...fields } =
      lines.filter((l) => l.msg === 'backup written').at(-1) ?? {};
    expect({ level, msg, pino: [time, pid, hostname].map((v) => v !== undefined) }).toEqual({
      level: 30,
      msg: 'backup written',
      pino: [true, true, true],
    });
    expect(fields).toEqual({
      path,
      bytes: statSync(path).size,
      uncompressedBytes: expect.any(Number) as unknown,
    });
  });

  it("writes nothing at boot when today's file exists", async () => {
    mkdirSync(dir, { recursive: true });
    const today = join(dir, 'expenses-2026-09-29.sqlite.gz');
    writeFileSync(today, 'earlier');
    const older = join(dir, 'expenses-2026-08-01.sqlite.gz');
    writeFileSync(older, 'old');
    const { lines, logger } = capture();

    const schedule = startBackups({ db, dir, ...DEFAULTS, now: () => AT, logger });
    await schedule.stop();

    expect(readdirSync(dir).sort()).toEqual([
      'expenses-2026-08-01.sqlite.gz',
      'expenses-2026-09-29.sqlite.gz',
    ]);
    expect(readFileSync(today, 'utf8')).toBe('earlier');
    expect(lines.filter((l) => l.msg === 'backup written')).toHaveLength(0);
  });

  it('logs one error line with the path and error name when the backup throws', async () => {
    const blocker = join(tmp, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const unwritable = join(blocker, 'backups');
    const { lines, logger } = capture();

    const schedule = startBackups({ db, dir: unwritable, ...DEFAULTS, now: () => AT, logger });
    await expect(schedule.stop()).resolves.toBeUndefined();

    const errors = lines.filter((l) => l.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'backup failed',
      path: join(unwritable, 'expenses-2026-09-29.sqlite.gz'),
      err: 'Error',
    });
    expect(lines.filter((l) => l.msg === 'backup written')).toHaveLength(0);
  });
});
