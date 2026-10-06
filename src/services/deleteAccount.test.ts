import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { insertLedger, insertMember, type LedgerId } from '../db/ledgers.js';
import { insertNoticeSeen } from '../db/notices.js';
import { insertRuleOrGetExisting, type RuleId } from '../db/recurring.js';
import type { User } from '../db/users.js';
import type { LocalDate } from '../domain/time.js';
import { decodeRsUrl } from '../domain/receipts/rsUrl.js';
import { buildRsUrl } from '../domain/receipts/testing/buildRsVl.js';
import { createLogger } from '../logger.js';
import {
  answerDebtAmount,
  answerDebtPersonName,
  answerSplitName,
  finishSplit,
  startDebt,
  startSplit,
} from './debts.js';
import { deleteAccount, isAccountDeleted } from './deleteAccount.js';
import { fetchDueReceipt, type FetchDeps } from './fetchDueReceipt.js';
import { createLedgerKeyring, type LedgerKeyring } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense } from './recordExpense.js';
import { recordReceipt } from './recordReceipt.js';
import { createReminder, createRuleFromExpense, dueRules, fireRule } from './recurring.js';
import { seedLedgerCategories } from './seedCategories.js';
import { sealPersonalLedger } from './testing/sealLedger.js';

const NOW = new Date('2026-10-01T08:00:00Z');

let db: Db;
let keys: LedgerKeyring;
let alice: User;
let fetcherCalls: number;

function deps(): FetchDeps & { keys: LedgerKeyring } {
  let n = 100;
  return {
    db,
    keys,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Belgrade',
    fetchers: {
      RS: () => {
        fetcherCalls++;
        return Promise.resolve({ kind: 'failed', reason: 'network' });
      },
      ME: () => Promise.reject(new Error('unused')),
    },
    placeholder: 'Чек',
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, NOW);
  keys = createLedgerKeyring(() => NOW);
  fetcherCalls = 0;
  alice = provisionUser(deps(), {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    now: NOW,
  }).user;
});

describe('deleteAccount', () => {
  it('leaves the receipt worker nothing to fetch for a deleted pending receipt', async () => {
    const decoded = decodeRsUrl(buildRsUrl());
    if (decoded.kind !== 'receipt') throw new Error('synthetic receipt did not decode');
    recordReceipt(deps(), {
      user: alice,
      receipt: decoded.receipt,
      placeholder: 'Чек',
      occurredAt: NOW,
      now: NOW,
    });
    expect(
      db.prepare("SELECT COUNT(*) FROM receipts WHERE fetch_state = 'pending'").pluck().get(),
    ).toBe(1);

    expect(deleteAccount(deps(), { telegramId: 1001, now: NOW })).toBe('deleted');

    const result = await fetchDueReceipt(deps(), {
      now: new Date(NOW.getTime() + 60_000),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: 'idle' });
    expect(fetcherCalls).toBe(0);
  });

  it('deletes a sealed ledger with its key rows, and answers a second call as already deleted', async () => {
    await sealPersonalLedger(deps(), alice, NOW);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_keys').pluck().get()).toBe(1);

    expect(deleteAccount(deps(), { telegramId: 1001, now: NOW })).toBe('deleted');
    expect(deleteAccount(deps(), { telegramId: 1001, now: NOW })).toBe('alreadyDeleted');

    expect(db.prepare('SELECT COUNT(*) FROM ledger_keys').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_key_wraps').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM ledgers').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM flow_sessions').pluck().get()).toBe(0);
    expect(isAccountDeleted(deps(), alice.id)).toBe(true);
  });

  it("deletes the user's one-time notices and no one else's", () => {
    let k = 0;
    const newId = () => `20000000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
    const bob = provisionUser(
      { ...deps(), newId },
      {
        provider: 'telegram',
        externalId: '1002',
        defaultTimezone: 'Europe/Belgrade',
        defaultCurrency: 'RSD',
        now: NOW,
      },
    ).user;
    insertNoticeSeen(db, alice.id, 'stray_help', NOW);
    insertNoticeSeen(db, alice.id, 'edit_hint', NOW);
    insertNoticeSeen(db, bob.id, 'stray_help', NOW);

    expect(deleteAccount(deps(), { telegramId: 1001, now: NOW })).toBe('deleted');

    expect(db.prepare('SELECT user_id FROM user_notices').pluck().all()).toEqual([bob.id]);
  });

  it("deletes the user's debt people and operations, split lends included, and no one else's", () => {
    let k = 0;
    const d = {
      ...deps(),
      newId: () => `20000000-0000-4000-8000-${String(++k).padStart(12, '0')}`,
      defaultCurrency: 'RSD' as const,
    };
    const bob = provisionUser(d, {
      provider: 'telegram',
      externalId: '1002',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    }).user;
    const lend = (user: User, name: string, key: string) => {
      const flow = startDebt(d, user, 'lend', NOW);
      if (flow.kind === 'locked') throw new Error('setup: locked');
      const asked = answerDebtAmount(d, {
        user,
        flow,
        text: '5000',
        inputKey: `${key}a`,
        now: NOW,
      });
      if (asked.kind !== 'askPerson') throw new Error('setup: amount');
      const recorded = answerDebtPersonName(d, {
        user,
        flow: asked.flow,
        text: name,
        inputKey: `${key}b`,
        now: NOW,
      });
      if (recorded.kind !== 'recorded') throw new Error('setup: person');
    };
    lend(alice, 'Петя', 'tg:1001:1');
    lend(bob, 'Аня', 'tg:1002:1');
    const expense = recordExpense(d, {
      user: alice,
      text: '1000 кафе',
      sourceKey: 'tg:1001:3',
      occurredAt: NOW,
      now: NOW,
    });
    if (expense.kind !== 'recorded') throw new Error('setup: expense');
    const split = startSplit(d, {
      user: alice,
      expenseId: expense.expense.id,
      each: 50000,
      currency: 'RSD',
      parts: 2,
      sourceKey: 'tg:1001:3',
      now: NOW,
    });
    if (split.kind === 'locked') throw new Error('setup: locked');
    answerSplitName(d, { user: alice, flow: split, text: 'Вася', inputKey: 'tg:1001:4', now: NOW });
    expect(finishSplit(d, { user: alice, now: NOW })).toMatchObject({ kind: 'recorded' });
    const count = (table: string, userId: string) =>
      db.prepare(`SELECT COUNT(*) FROM ${table} WHERE user_id = ?`).pluck().get(userId);
    expect(count('debt_ops', alice.id)).toBe(2);
    expect(count('debt_people', alice.id)).toBe(2);

    expect(deleteAccount(d, { telegramId: 1001, now: NOW })).toBe('deleted');

    expect(count('debt_ops', alice.id)).toBe(0);
    expect(count('debt_people', alice.id)).toBe(0);
    expect(count('debt_ops', bob.id)).toBe(1);
    expect(count('debt_people', bob.id)).toBe(1);
  });

  it("deletes the user's rules, reminders and occurrences in every ledger, and no one else's", () => {
    let k = 0;
    const d = {
      ...deps(),
      newId: () => `10000000-0000-4000-8000-${String(++k).padStart(12, '0')}`,
    };
    const bob = provisionUser(d, {
      provider: 'telegram',
      externalId: '1002',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: NOW,
    }).user;
    const recorded = recordExpense(d, {
      user: alice,
      text: '45000 аренда',
      sourceKey: 'tg:1001:1',
      occurredAt: NOW,
      now: NOW,
    });
    if (recorded.kind !== 'recorded') throw new Error('setup failed');
    const made = createRuleFromExpense(d, {
      user: alice,
      expenseId: recorded.expense.id,
      choice: 'm',
      now: NOW,
    });
    if (made.kind !== 'created') throw new Error('rule not made');
    createReminder(d, { user: alice, text: 'оплатить интернет', choice: 'm', now: NOW });
    createReminder(d, { user: bob, text: 'полить цветы', choice: 'm', now: NOW });
    const groupId = 'group-ledger' as LedgerId;
    insertLedger(db, {
      id: groupId,
      kind: 'shared',
      name: 'Квартира',
      defaultCurrency: 'RSD',
      timezone: 'Europe/Belgrade',
      ownerUserId: bob.id,
      createdAt: NOW,
    });
    seedLedgerCategories(db, groupId, NOW);
    insertMember(db, { ledgerId: groupId, userId: bob.id, role: 'owner' });
    insertMember(db, { ledgerId: groupId, userId: alice.id, role: 'member' });
    insertRuleOrGetExisting(db, {
      id: 'group-rule' as RuleId,
      ledgerId: groupId,
      userId: alice.id,
      kind: 'expense',
      mode: 'auto',
      template: { amountMinor: 120000, currency: 'RSD', description: 'уборка', categoryId: null },
      sealedTemplate: null,
      reminderText: null,
      schedule: { kind: 'monthly', day: 1 },
      nextDueOn: '2026-11-01' as LocalDate,
      sourceKey: null,
      createdAt: NOW,
    });
    // 09:00 in Belgrade on 1 November: the rent and the group rule record, both reminders send.
    const due = new Date('2026-11-01T08:00:00Z');
    for (const rule of dueRules(d, due)) fireRule(d, rule, due);
    expect(
      db.prepare('SELECT outcome FROM recurring_occurrences ORDER BY outcome').pluck().all(),
    ).toEqual(['recorded', 'recorded', 'reminded', 'reminded']);

    expect(deleteAccount(d, { telegramId: 1001, now: due })).toBe('deleted');

    const count = (sql: string, ...params: string[]) =>
      db
        .prepare(sql)
        .pluck()
        .get(...params);
    expect(count('SELECT COUNT(*) FROM recurring_rules WHERE user_id = ?', alice.id)).toBe(0);
    expect(count('SELECT reminder_text FROM recurring_rules WHERE user_id = ?', bob.id)).toBe(
      'полить цветы',
    );
    expect(
      db
        .prepare(
          'SELECT o.outcome FROM recurring_occurrences o JOIN recurring_rules r ON r.id = o.rule_id',
        )
        .pluck()
        .all(),
    ).toEqual(['reminded']);
    expect(count('SELECT COUNT(*) FROM recurring_occurrences')).toBe(1);
    // The group's expense stays, under a deleted member.
    expect(
      count(
        'SELECT amount_minor FROM expenses WHERE ledger_id = ? AND created_by = ?',
        groupId,
        alice.id,
      ),
    ).toBe(120000);
  });
});
