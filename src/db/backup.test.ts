import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { BACKUP_INTERVAL_MS, backupDatabase, startBackups } from './backup.js';
import { openDatabase, type Db } from './connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from './expenses.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import { runMigrations } from './migrate.js';
import { insertUser, type UserId } from './users.js';

// 22:30 UTC is already 30 September in Belgrade: backup names follow the UTC date.
const AT = new Date('2026-09-29T22:30:00Z');
const USER = 'user-a' as UserId;
const LEDGER = 'ledger-a' as LedgerId;

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
      amountMinor: 45000,
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

function countExpenses(path: string): number {
  const copy = new Database(path, { readonly: true });
  try {
    return copy.prepare<[], { n: number }>('SELECT count(*) AS n FROM expenses').get()?.n ?? -1;
  } finally {
    copy.close();
  }
}

describe('backupDatabase', () => {
  it('writes a copy named after the UTC date', async () => {
    const result = await backupDatabase(db, dir, 14, AT);
    const path = join(dir, 'expenses-2026-09-29.sqlite');
    expect(result.path).toBe(path);
    expect(result.bytes).toBe(statSync(path).size);
    expect(countExpenses(path)).toBe(3);
  });

  it('replaces a same-day backup and leaves no temp file', async () => {
    await backupDatabase(db, dir, 14, AT);
    db.prepare('DELETE FROM expenses WHERE id = ?').run('expense-3');
    await backupDatabase(db, dir, 14, new Date('2026-09-29T23:59:00Z'));
    expect(readdirSync(dir)).toEqual(['expenses-2026-09-29.sqlite']);
    expect(countExpenses(join(dir, 'expenses-2026-09-29.sqlite'))).toBe(2);
  });

  it('keeps the newest BACKUP_KEEP dated files and ignores other names', async () => {
    await backupDatabase(db, dir, 14, new Date('2026-09-01T00:00:00Z'));
    rmSync(join(dir, 'expenses-2026-09-01.sqlite'));
    const dated = Array.from({ length: 15 }, (_, i) => `expenses-2026-09-${String(14 + i)}.sqlite`);
    for (const name of [...dated, 'notes.txt', 'expenses-manual.sqlite']) {
      writeFileSync(join(dir, name), 'x');
    }

    const result = await backupDatabase(db, dir, 14, AT);

    const kept = Array.from({ length: 14 }, (_, i) => `expenses-2026-09-${String(16 + i)}.sqlite`);
    expect(readdirSync(dir).sort()).toEqual(
      [...kept, 'expenses-manual.sqlite', 'notes.txt'].sort(),
    );
    expect(result.rotatedOut).toEqual([
      join(dir, 'expenses-2026-09-15.sqlite'),
      join(dir, 'expenses-2026-09-14.sqlite'),
    ]);
  });

  it('creates a missing directory with mode 0700', async () => {
    expect(existsSync(dir)).toBe(false);
    await backupDatabase(db, dir, 14, AT);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
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
    const schedule = startBackups({ db, dir, keep: 14, now: () => new Date(), logger });

    await vi.waitFor(() => {
      expect(lines.filter((l) => l.msg === 'backup written')).toHaveLength(1);
    });
    expect(readdirSync(dir)).toEqual(['expenses-2026-09-29.sqlite']);

    vi.advanceTimersByTime(BACKUP_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(lines.filter((l) => l.msg === 'backup written')).toHaveLength(2);
    });
    await schedule.stop();

    expect(readdirSync(dir).sort()).toEqual([
      'expenses-2026-09-29.sqlite',
      'expenses-2026-09-30.sqlite',
    ]);
    const path = join(dir, 'expenses-2026-09-30.sqlite');
    // Beyond pino's own keys, the line carries the path and the size only.
    const { level, time, pid, hostname, msg, ...fields } =
      lines.filter((l) => l.msg === 'backup written').at(-1) ?? {};
    expect({ level, msg, pino: [time, pid, hostname].map((v) => v !== undefined) }).toEqual({
      level: 30,
      msg: 'backup written',
      pino: [true, true, true],
    });
    expect(fields).toEqual({ path, bytes: statSync(path).size });
  });

  it('logs one error line with the path and error name when the backup throws', async () => {
    const blocker = join(tmp, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const unwritable = join(blocker, 'backups');
    const { lines, logger } = capture();

    const schedule = startBackups({ db, dir: unwritable, keep: 14, now: () => AT, logger });
    await expect(schedule.stop()).resolves.toBeUndefined();

    const errors = lines.filter((l) => l.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: 'backup failed',
      path: join(unwritable, 'expenses-2026-09-29.sqlite'),
      err: 'Error',
    });
    expect(lines.filter((l) => l.msg === 'backup written')).toHaveLength(0);
  });
});
