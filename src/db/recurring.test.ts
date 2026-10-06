import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/time.js';
import { openDatabase, type Db } from './connection.js';
import { runMigrations } from './migrate.js';
import { insertLedger, insertMember, type LedgerId } from './ledgers.js';
import {
  advanceRule,
  findRule,
  findRuleAuthor,
  insertOccurrenceOrIgnore,
  insertRuleOrGetExisting,
  listRulesDueBy,
  listUserRules,
  type NewRule,
  type RuleId,
} from './recurring.js';
import { insertIdentity, insertUser, type UserId } from './users.js';

const NOW = new Date('2026-10-02T10:00:00Z');
const USER = 'u-1' as UserId;
const LEDGER = 'l-1' as LedgerId;

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  insertUser(db, { id: USER, timezone: 'Europe/Belgrade', createdAt: NOW });
  insertIdentity(db, { provider: 'telegram', externalId: '1001', userId: USER });
  insertLedger(db, {
    id: LEDGER,
    kind: 'personal',
    name: 'Personal',
    defaultCurrency: 'RSD',
    ownerUserId: USER,
    createdAt: NOW,
  });
  insertMember(db, { ledgerId: LEDGER, userId: USER, role: 'owner' });
});

function rule(id: string, overrides: Partial<NewRule> = {}): NewRule {
  return {
    id: id as RuleId,
    ledgerId: LEDGER,
    userId: USER,
    kind: 'expense',
    mode: 'auto',
    template: { amountMinor: 4500000, currency: 'RSD', description: 'аренда', categoryId: null },
    reminderText: null,
    schedule: { kind: 'monthly', day: 1 },
    nextDueOn: '2026-11-01' as LocalDate,
    sourceKey: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('recurring rules', () => {
  it('stores and reads back a rule', () => {
    insertRuleOrGetExisting(db, rule('r-1'));

    expect(findRule(db, 'r-1' as RuleId)).toEqual({
      id: 'r-1',
      ledgerId: LEDGER,
      userId: USER,
      kind: 'expense',
      mode: 'auto',
      template: { amountMinor: 4500000, currency: 'RSD', description: 'аренда', categoryId: null },
      reminderText: null,
      schedule: { kind: 'monthly', day: 1 },
      nextDueOn: '2026-11-01',
      pausedAt: null,
      deletedAt: null,
    });
  });

  it('returns the live rule with the same source key instead of a second one', () => {
    const first = insertRuleOrGetExisting(db, rule('r-1', { sourceKey: 'exp:e-1:m' }));
    const second = insertRuleOrGetExisting(db, rule('r-2', { sourceKey: 'exp:e-1:m' }));

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, rule: { id: 'r-1' } });
    expect(listUserRules(db, USER).map((r) => r.id)).toEqual(['r-1']);
  });

  it('lists the rules due by a date', () => {
    insertRuleOrGetExisting(db, rule('r-1'));
    insertRuleOrGetExisting(db, rule('r-2', { nextDueOn: '2026-11-02' as LocalDate }));

    expect(listRulesDueBy(db, '2026-11-01' as LocalDate).map((r) => r.id)).toEqual(['r-1']);
  });

  it('advances only from the date it still reads', () => {
    insertRuleOrGetExisting(db, rule('r-1'));
    const id = 'r-1' as RuleId;

    expect(advanceRule(db, id, '2026-11-01' as LocalDate, '2026-12-01' as LocalDate)).toBe(true);
    expect(advanceRule(db, id, '2026-11-01' as LocalDate, '2026-12-01' as LocalDate)).toBe(false);
    expect(findRule(db, id)?.nextDueOn).toBe('2026-12-01');
  });

  it('claims an occurrence once', () => {
    insertRuleOrGetExisting(db, rule('r-1'));
    const occurrence = {
      ruleId: 'r-1' as RuleId,
      dueOn: '2026-11-01' as LocalDate,
      outcome: 'asked' as const,
      expenseId: null,
    };

    expect(insertOccurrenceOrIgnore(db, occurrence)).toBe(true);
    expect(insertOccurrenceOrIgnore(db, occurrence)).toBe(false);
  });

  it('finds the author with their Telegram id', () => {
    expect(findRuleAuthor(db, USER)).toEqual({
      user: { id: USER, timezone: 'Europe/Belgrade', activeLedgerId: null },
      telegramId: 1001,
    });
  });
});
