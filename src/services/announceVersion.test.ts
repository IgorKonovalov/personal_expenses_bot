import { beforeEach, describe, expect, it } from 'vitest';
import { getAppState, setAppState } from '../db/appState.js';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { announceVersion, type AnnounceDeps } from './announceVersion.js';

const ANNOUNCEMENTS = {
  '0.3.0': 'synthetic body 0.3.0',
  '0.3.1': 'synthetic body 0.3.1',
};

let db: Db;
let sent: [string, string][];
let logLines: string[];

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, new Date('2026-09-30T10:00:00Z'));
  sent = [];
  logLines = [];
});

function deps(
  overrides: Partial<Pick<AnnounceDeps<string>, 'send' | 'announcements'>> = {},
): AnnounceDeps<string> {
  return {
    db,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    announcements: ANNOUNCEMENTS,
    send: (version, body) => {
      sent.push([version, body]);
      return Promise.resolve();
    },
    ...overrides,
  };
}

function lastAnnounced(): string | undefined {
  return getAppState(db, 'last_announced_version');
}

function logged(): Record<string, unknown>[] {
  return logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('announceVersion', () => {
  it('announces 0.3.0 once when nothing was announced yet, then records it', async () => {
    expect(await announceVersion(deps(), '0.3.0')).toBe('announced');

    expect(sent).toEqual([['0.3.0', 'synthetic body 0.3.0']]);
    expect(lastAnnounced()).toBe('0.3.0');
  });

  it('sends nothing on a second boot with the same version', async () => {
    await announceVersion(deps(), '0.3.0');
    sent.length = 0;

    expect(await announceVersion(deps(), '0.3.0')).toBe('unchanged');

    expect(sent).toEqual([]);
    expect(lastAnnounced()).toBe('0.3.0');
  });

  it('announces a patch bump', async () => {
    setAppState(db, 'last_announced_version', '0.3.0');

    expect(await announceVersion(deps(), '0.3.1')).toBe('announced');

    expect(sent).toEqual([['0.3.1', 'synthetic body 0.3.1']]);
    expect(lastAnnounced()).toBe('0.3.1');
  });

  it('keeps the old version and warns without the body when send rejects', async () => {
    setAppState(db, 'last_announced_version', '0.3.0');
    class GrammyError extends Error {
      override name = 'GrammyError';
    }
    const failing = deps({
      send: () => Promise.reject(new GrammyError('Forbidden: bot was blocked by the user')),
    });

    await expect(announceVersion(failing, '0.3.1')).resolves.toBe('failed');

    expect(lastAnnounced()).toBe('0.3.0');
    const warns = logged().filter((line) => line.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ version: '0.3.1', err: 'GrammyError' });
    for (const line of logLines) expect(line).not.toContain('synthetic body');
  });

  it('sends nothing and logs an error when the version has no announcement', async () => {
    setAppState(db, 'last_announced_version', '0.3.0');

    expect(await announceVersion(deps(), '0.4.0')).toBe('missing');

    expect(sent).toEqual([]);
    expect(lastAnnounced()).toBe('0.3.0');
    expect(logged()).toMatchObject([{ level: 50, version: '0.4.0' }]);
  });
});
