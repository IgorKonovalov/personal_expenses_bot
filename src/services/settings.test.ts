import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import type { LedgerId } from '../db/ledgers.js';
import { findUserByIdentity, type User } from '../db/users.js';
import { createLogger } from '../logger.js';
import { routeText } from './flowSessions.js';
import { bindGroup, recordGroupExpense } from './groupChats.js';
import { provisionUser } from './provisionUser.js';
import type { RecordDeps } from './recordExpense.js';
import {
  answerTimezoneFlow,
  ledgerSettings,
  resolveUserTimezone,
  setLedgerCurrency,
  setLedgerTimezone,
  startTimezoneFlow,
  switchTidyChat,
  tidyChatOn,
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

describe('tidy chat', () => {
  it('is off for a new user and switches on and off, reporting a change', () => {
    expect(tidyChatOn(deps, user)).toBe(false);

    expect(switchTidyChat(deps, user, true)).toBe(true);
    expect(switchTidyChat(deps, user, true)).toBe(false);
    expect(tidyChatOn(deps, user)).toBe(true);

    expect(switchTidyChat(deps, user, false)).toBe(true);
    expect(tidyChatOn(deps, user)).toBe(false);
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

describe('setLedgerTimezone', () => {
  let ledgerId: LedgerId;
  let member: User;

  beforeEach(() => {
    const groupDeps = { ...deps, defaultCurrency: 'RSD' as const };
    ledgerId = bindGroup(groupDeps, {
      chatId: -100500,
      title: 'Семья',
      adder: { telegramId: 1001, firstName: 'Анна' },
      now: NOW,
    }).ledger.id;
    recordGroupExpense(groupDeps, {
      chatId: -100500,
      sender: { telegramId: 2002, firstName: 'Борис' },
      text: '300 такси',
      sourceKey: 'tg:-100500:1',
      occurredAt: NOW,
      now: NOW,
    });
    member = findUserByIdentity(db, 'telegram', '2002') as User;
  });

  const ledgerTimezone = () =>
    db.prepare('SELECT timezone FROM ledgers WHERE id = ?').pluck().get(ledgerId);

  it("sets the shared ledger's zone for its owner and leaves the owner's own zone", () => {
    expect(setLedgerTimezone(deps, { user, ledgerId, timezone: 'America/New_York' })).toEqual({
      kind: 'updated',
    });
    expect(ledgerTimezone()).toBe('America/New_York');
    expect(storedTimezone()).toBe('Europe/Belgrade');
    expect(setLedgerTimezone(deps, { user, ledgerId, timezone: 'America/New_York' })).toEqual({
      kind: 'unchanged',
    });
    expect(ledgerSettings(deps, user, ledgerId)?.timezone).toBe('America/New_York');
  });

  it('refuses a member who is not the owner, and a personal ledger', () => {
    expect(
      setLedgerTimezone(deps, { user: member, ledgerId, timezone: 'America/New_York' }),
    ).toEqual({ kind: 'forbidden' });
    expect(ledgerTimezone()).toBe('Europe/Belgrade');
    expect(ledgerSettings(deps, member, ledgerId)).toBeUndefined();

    const personal = userSettings(deps, user).ledger.id;
    expect(
      setLedgerTimezone(deps, { user, ledgerId: personal, timezone: 'America/New_York' }),
    ).toEqual({ kind: 'forbidden' });
  });

  it("stores a typed zone for the flow's ledger, not the user", () => {
    startTimezoneFlow(deps, user, NOW, ledgerId);

    expect(
      answerTimezoneFlow(deps, {
        user,
        text: 'america/new_york',
        inputKey: 'tg:1001:9',
        ledgerId,
      }),
    ).toEqual({ kind: 'updated', timezone: 'America/New_York' });
    expect(ledgerTimezone()).toBe('America/New_York');
    expect(storedTimezone()).toBe('Europe/Belgrade');
  });
});
