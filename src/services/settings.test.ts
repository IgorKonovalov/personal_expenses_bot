import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { routeText } from './flowSessions.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import {
  answerTimezoneFlow,
  resolveUserTimezone,
  setLedgerCurrency,
  startTimezoneFlow,
  updateTimezone,
  userSettings,
} from './settings.js';

const NOW = new Date('2026-09-30T10:00:00Z');

let db: Db;
let deps: RecordDeps;
let logLines: string[];
let user: User;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  let n = 0;
  logLines = [];
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('info', { write: (line: string) => void logLines.push(line) }),
    defaultTimezone: 'Europe/Belgrade',
  };
  user = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
});

function storedTimezone(): unknown {
  return db.prepare('SELECT timezone FROM users WHERE id = ?').pluck().get(user.id);
}

describe('resolveUserTimezone', () => {
  it('uses the stored zone and logs nothing', () => {
    expect(resolveUserTimezone(deps, { ...user, timezone: 'Europe/Moscow' })).toBe('Europe/Moscow');
    expect(logLines).toEqual([]);
  });

  it('falls back to the default for a corrupt zone and logs one warn with the user id only', () => {
    expect(resolveUserTimezone(deps, { ...user, timezone: 'Mars/Base' })).toBe('Europe/Belgrade');
    expect(logLines).toHaveLength(1);
    const line = JSON.parse(logLines[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 40, userId: user.id });
    expect(JSON.stringify(line)).not.toContain('Mars');
  });
});

describe('userSettings', () => {
  it('names the zone in effect and the active ledger', () => {
    const view = userSettings(deps, user);
    expect(view.timezone).toBe('Europe/Belgrade');
    expect(view.ledger).toMatchObject({ kind: 'personal', defaultCurrency: 'RSD' });
  });
});

describe('updateTimezone', () => {
  it('stores a new zone, and reports unchanged for the stored one', () => {
    expect(updateTimezone(deps, { user, timezone: 'Europe/Moscow' })).toEqual({ kind: 'updated' });
    expect(storedTimezone()).toBe('Europe/Moscow');
    expect(updateTimezone(deps, { user, timezone: 'Europe/Moscow' })).toEqual({
      kind: 'unchanged',
    });
  });
});

describe('answerTimezoneFlow', () => {
  beforeEach(() => {
    startTimezoneFlow(deps, user, NOW);
  });

  it('stores the canonical spelling and completes the flow', () => {
    expect(answerTimezoneFlow(deps, { user, text: 'asia/tbilisi', inputKey: 'tg:1:5' })).toEqual({
      kind: 'updated',
      timezone: 'Asia/Tbilisi',
    });
    expect(storedTimezone()).toBe('Asia/Tbilisi');
    expect(routeText(deps, { user, inputKey: 'tg:1:5', now: NOW })).toEqual({
      kind: 'redelivered',
    });
    expect(routeText(deps, { user, inputKey: 'tg:1:6', now: NOW })).toEqual({
      kind: 'free',
      expiredFlow: false,
    });
  });

  it.each([
    ['Mars/Base', 'unknown'],
    ['+03:00', 'unknown'],
    ['450 кофе', 'expenseShaped'],
  ])('refuses %j as %s and keeps the flow pending', (text, reason) => {
    expect(answerTimezoneFlow(deps, { user, text, inputKey: 'tg:1:5' })).toEqual({
      kind: 'invalid',
      reason,
    });
    expect(storedTimezone()).toBe('Europe/Belgrade');
    expect(routeText(deps, { user, inputKey: 'tg:1:6', now: NOW })).toEqual({
      kind: 'flow',
      flow: { kind: 'setTimezone' },
    });
  });
});

describe('setLedgerCurrency', () => {
  function storedCurrency(): unknown {
    return db.prepare('SELECT default_currency FROM ledgers').pluck().get();
  }

  it("sets the owner's active ledger currency, and reports unchanged for the stored one", () => {
    expect(setLedgerCurrency(deps, { user, currency: 'EUR' })).toMatchObject({
      kind: 'updated',
      ledger: { defaultCurrency: 'EUR' },
    });
    expect(storedCurrency()).toBe('EUR');
    expect(setLedgerCurrency(deps, { user, currency: 'EUR' })).toMatchObject({
      kind: 'unchanged',
    });
  });

  it('refuses a member who is not the owner and writes nothing', () => {
    db.prepare("UPDATE ledger_members SET role = 'member'").run();

    expect(setLedgerCurrency(deps, { user, currency: 'EUR' })).toMatchObject({
      kind: 'forbidden',
    });
    expect(storedCurrency()).toBe('RSD');
  });
});
