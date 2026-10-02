import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/connection.js';
import { softDeleteExpense } from '../db/expenses.js';
import type { Ledger } from '../db/ledgers.js';
import { runMigrations } from '../db/migrate.js';
import type { User } from '../db/users.js';
import { createLogger } from '../logger.js';
import type { CategoryId } from '../db/categories.js';
import { createLedgerKeyring, isLocked, type LedgerKeyring, type Locked } from './ledgerKeys.js';
import {
  answerBudgetFlow,
  budgetScreen,
  clearCap,
  groupBudgetStatus,
  memberBudgetStatus,
  setScope,
  startBudgetFlow,
} from './budget.js';
import { bindGroup, recordGroupExpense } from './groupChats.js';
import { provisionUser } from './provisionUser.js';
import { recordExpense, type RecordDeps } from './recordExpense.js';

// 2026-10-01 12:00 in Moscow (UTC+3).
const OCT_1 = new Date('2026-10-01T09:00:00Z');
const OCT_2 = new Date('2026-10-02T09:00:00Z');

let db: Db;
let deps: RecordDeps & { keys: LedgerKeyring };
let user: User;
let ledger: Ledger;
let messageId = 0;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, OCT_1);
  let n = 0;
  deps = {
    db,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: createLogger('silent'),
    defaultTimezone: 'Europe/Moscow',
    keys: createLedgerKeyring(),
  };
  const provisioned = provisionUser(deps, {
    provider: 'telegram',
    externalId: '1001',
    defaultTimezone: 'Europe/Moscow',
    defaultCurrency: 'RUB',
    now: OCT_1,
  });
  user = provisioned.user;
  ledger = provisioned.ledger;
});

function setLimit(text: string, now: Date = OCT_1) {
  const flow = { kind: 'budgetLimit', ledgerId: ledger.id } as const;
  expect(startBudgetFlow(deps, { user, flow, now })).toBe(true);
  return answerBudgetFlow(deps, { user, flow, text, inputKey: `tg:1:${++messageId}`, now });
}

function spend(text: string, at: Date) {
  const result = recordExpense(deps, {
    user,
    text,
    sourceKey: `tg:1001:${++messageId}`,
    occurredAt: at,
    now: at,
  });
  if (result.kind !== 'recorded') throw new Error(`not recorded: ${result.kind}`);
  return result.expense;
}

// A plaintext ledger never reads as locked.
function plain<T extends object>(value: T | Locked | undefined): T | undefined {
  if (isLocked(value)) throw new Error('a plaintext ledger read as locked');
  return value;
}

const status = (now: Date) => plain(memberBudgetStatus(deps, { user, ledger, now }));

describe('budgetStatus over a calendar month (ADR-0017)', () => {
  it('has no budget before a limit is set', () => {
    expect(status(OCT_1)).toBeUndefined();
  });

  it('takes 450 кофе from day 1 and 300 такси from day 2 of a 30000 limit', () => {
    expect(setLimit('30000').kind).toBe('set');

    spend('450 кофе', OCT_1);
    expect(status(OCT_1)).toMatchObject({
      currency: 'RUB',
      period: { from: '2026-10-01', to: '2026-10-31', day: 1, days: 31 },
      limit: { limitMinor: 3_000_000, todayLeftMinor: 51_774, periodLeftMinor: 2_955_000 },
    });

    spend('300 такси', OCT_2);
    expect(status(OCT_2)?.limit).toEqual({
      limitMinor: 3_000_000,
      spentMinor: 75_000,
      todayLeftMinor: 118_548,
      periodLeftMinor: 2_925_000,
    });
  });

  it('carries day 1 overspend into day 2', () => {
    setLimit('30000');
    spend('1500 ресторан', OCT_1);

    expect(status(OCT_1)?.limit?.todayLeftMinor).toBe(-53_226);
    expect(status(OCT_2)?.limit?.todayLeftMinor).toBe(43_548);
  });

  it('counts neither an EUR expense nor a deleted one, and lists the EUR one apart', () => {
    setLimit('30000');
    spend('450 кофе', OCT_1);
    spend('12,50 EUR такси', OCT_1);
    const deleted = spend('1000 ужин', OCT_1);
    softDeleteExpense(db, deleted.id, OCT_1);

    const s = status(OCT_1);
    expect(s?.limit?.todayLeftMinor).toBe(51_774);
    expect(s?.limit?.periodLeftMinor).toBe(2_955_000);
    expect([...(s?.notCounted ?? [])]).toEqual([['EUR', 1_250]]);
  });
});

describe('payday periods', () => {
  function setStartDay(text: string, now: Date) {
    const flow = { kind: 'budgetStartDay', ledgerId: ledger.id } as const;
    expect(startBudgetFlow(deps, { user, flow, now })).toBe(true);
    return answerBudgetFlow(deps, { user, flow, text, inputKey: `tg:1:${++messageId}`, now });
  }

  it('leaves an expense dated the 9th out of a period starting on the 10th', () => {
    // 2026-10-10 12:00 in Moscow: day 1 of the 31-day period 10 Oct - 9 Nov.
    const OCT_10 = new Date('2026-10-10T09:00:00Z');
    expect(setStartDay('10', OCT_10).kind).toBe('set');
    setLimit('30000', OCT_10);

    spend('500 такси вчера', OCT_10);

    expect(status(OCT_10)).toMatchObject({
      period: { from: '2026-10-10', to: '2026-11-09', day: 1, days: 31 },
      limit: { todayLeftMinor: 96_774, periodLeftMinor: 3_000_000 },
    });
  });

  it('refuses a day outside 1..31 and keeps the budget without a limit', () => {
    expect(setStartDay('0', OCT_1)).toMatchObject({ kind: 'invalid', reason: 'invalidDay' });
    expect(setStartDay('32', OCT_1)).toMatchObject({ kind: 'invalid', reason: 'invalidDay' });
    expect(setStartDay('десятое', OCT_1)).toMatchObject({ kind: 'invalid', reason: 'invalidDay' });
    expect(setStartDay('31', OCT_1).kind).toBe('set');
    expect(status(OCT_1)).toMatchObject({
      currency: 'RUB',
      period: { from: '2026-09-30', to: '2026-10-30' },
    });
    expect(status(OCT_1)?.limit).toBeUndefined();
  });
});

describe('the optional-only scope', () => {
  it('leaves groceries out of a 20000 limit with scope optional, and counts them with scope all', () => {
    setLimit('20000');
    expect(setScope(deps, { user, ledgerId: ledger.id, scope: 'optional', now: OCT_1 })).toEqual({
      kind: 'set',
    });
    spend('3000 продукты', OCT_1);
    spend('450 кофе', OCT_1);

    expect(status(OCT_1)?.limit).toMatchObject({ spentMinor: 45_000, periodLeftMinor: 1_955_000 });

    expect(setScope(deps, { user, ledgerId: ledger.id, scope: 'all', now: OCT_1 }).kind).toBe(
      'set',
    );
    expect(status(OCT_1)?.limit).toMatchObject({ spentMinor: 345_000, periodLeftMinor: 1_655_000 });
  });

  it('counts an uncategorised expense as optional, and a repeated scope is unchanged', () => {
    setLimit('20000');
    setScope(deps, { user, ledgerId: ledger.id, scope: 'optional', now: OCT_1 });
    const groceries = spend('3000 продукты', OCT_1);
    db.prepare('UPDATE expenses SET category_id = NULL WHERE id = ?').run(groceries.id);

    expect(status(OCT_1)?.limit?.spentMinor).toBe(300_000);
    expect(setScope(deps, { user, ledgerId: ledger.id, scope: 'optional', now: OCT_1 }).kind).toBe(
      'unchanged',
    );
  });
});

describe('category caps', () => {
  const cafeId = () =>
    db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .pluck()
      .get(ledger.id) as CategoryId;

  function setCap(categoryId: CategoryId, text: string) {
    const flow = { kind: 'budgetCap', ledgerId: ledger.id, categoryId } as const;
    expect(startBudgetFlow(deps, { user, flow, now: OCT_1 })).toBe(true);
    return answerBudgetFlow(deps, {
      user,
      flow,
      text,
      inputKey: `tg:1:${++messageId}`,
      now: OCT_1,
    });
  }

  it('counts 450 кофе and 4800 ресторан against a 5000 café cap with no overall limit', () => {
    expect(setCap(cafeId(), '5000').kind).toBe('set');
    spend('450 кофе', OCT_1);
    spend('4800 ресторан', OCT_1);
    spend('300 такси', OCT_1);

    const s = status(OCT_1);
    expect(s?.limit).toBeUndefined();
    expect(s?.caps).toEqual([
      { categoryId: cafeId(), name: 'Кафе и рестораны', spentMinor: 525_000, capMinor: 500_000 },
    ]);
    const cafe = s?.caps[0];
    expect(cafe === undefined ? undefined : cafe.spentMinor - cafe.capMinor).toBe(25_000);
  });

  it("drops an archived category's cap, and clearing converges", () => {
    setCap(cafeId(), '5000');
    expect(clearCap(deps, { user, ledgerId: ledger.id, categoryId: cafeId() }).kind).toBe(
      'cleared',
    );
    expect(clearCap(deps, { user, ledgerId: ledger.id, categoryId: cafeId() }).kind).toBe(
      'unchanged',
    );

    setCap(cafeId(), '5000');
    db.prepare("UPDATE categories SET archived_at = 'x' WHERE id = ?").run(cafeId());
    expect(status(OCT_1)?.caps).toEqual([]);
  });
});

describe('a limit in a new currency', () => {
  const cafeId = () =>
    db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .pluck()
      .get(ledger.id) as CategoryId;
  const capRows = () =>
    db
      .prepare(
        `SELECT k.cap_minor FROM category_caps k JOIN categories c ON c.id = k.category_id
          WHERE c.ledger_id = ?`,
      )
      .pluck()
      .all(ledger.id);
  const budgetRow = () =>
    db
      .prepare('SELECT limit_minor, currency FROM ledger_budgets WHERE ledger_id = ?')
      .get(ledger.id);

  // A RUB ledger with a 30000 limit and a 5000 cap on «Кафе и рестораны».
  beforeEach(() => {
    setLimit('30000');
    const flow = { kind: 'budgetCap', ledgerId: ledger.id, categoryId: cafeId() } as const;
    expect(startBudgetFlow(deps, { user, flow, now: OCT_1 })).toBe(true);
    const text = '5000';
    answerBudgetFlow(deps, { user, flow, text, inputKey: `tg:1:${++messageId}`, now: OCT_1 });
    expect(capRows()).toEqual([500_000]);
  });

  function switchToEur() {
    db.prepare("UPDATE ledgers SET default_currency = 'EUR' WHERE id = ?").run(ledger.id);
    ledger = { ...ledger, defaultCurrency: 'EUR' };
  }

  it('deletes the caps and reports their currency', () => {
    switchToEur();
    expect(setLimit('1000')).toEqual({ kind: 'set', ledger, droppedCapsCurrency: 'RUB' });
    expect(budgetRow()).toEqual({ limit_minor: 100_000, currency: 'EUR' });
    expect(capRows()).toEqual([]);
  });

  it('keeps the caps when the currency is unchanged', () => {
    expect(setLimit('40000')).toEqual({ kind: 'set', ledger });
    expect(budgetRow()).toEqual({ limit_minor: 4_000_000, currency: 'RUB' });
    expect(capRows()).toEqual([500_000]);
  });

  it('leaves the limit and the caps as they were when the transaction fails', () => {
    switchToEur();
    db.exec(
      `CREATE TRIGGER fail_budget BEFORE UPDATE ON ledger_budgets
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    expect(() => setLimit('1000')).toThrow('injected');
    expect(budgetRow()).toEqual({ limit_minor: 3_000_000, currency: 'RUB' });
    expect(capRows()).toEqual([500_000]);
  });
});

describe('a group ledger (ADR-0015)', () => {
  const CHAT = -100500;
  const groupDeps = () => ({
    ...deps,
    defaultTimezone: 'Europe/Belgrade',
    keys: createLedgerKeyring(),
    defaultCurrency: 'RSD' as const,
  });
  const sender = (telegramId: number, firstName: string) => ({ telegramId, firstName });

  function bound() {
    const { ledger: group } = bindGroup(groupDeps(), {
      chatId: CHAT,
      title: 'Семья',
      adder: sender(3003, 'Анна'),
      now: OCT_1,
    });
    const owner = provisionUser(deps, {
      provider: 'telegram',
      externalId: '3003',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: OCT_1,
    }).user;
    return { group, owner };
  }

  it('counts 450 кафе sent at 00:30 Belgrade on 2 October on day 2, not day 1', () => {
    const { group, owner } = bound();
    expect(group).toMatchObject({ timezone: 'Europe/Belgrade', defaultCurrency: 'RSD' });
    const flow = { kind: 'budgetLimit', ledgerId: group.id } as const;
    expect(startBudgetFlow(deps, { user: owner, flow, now: OCT_1 })).toBe(true);
    const text = '30000';
    expect(
      answerBudgetFlow(deps, { user: owner, flow, text, inputKey: 'tg:3003:1', now: OCT_1 }).kind,
    ).toBe('set');

    const sentAt = new Date('2026-10-01T22:30:00Z');
    recordGroupExpense(groupDeps(), {
      chatId: CHAT,
      sender: sender(3003, 'Анна'),
      text: '450 кафе',
      sourceKey: 'tg:-100500:1',
      occurredAt: sentAt,
      now: sentAt,
    });

    const { status: s } = groupBudgetStatus(deps, { chatId: CHAT, now: sentAt }) ?? {};
    expect(s?.period).toEqual({ from: '2026-10-01', to: '2026-10-31', day: 2, days: 31 });
    expect(s?.limit?.todayLeftMinor).toBe(148_548);
  });

  it("refuses a member who isn't the owner the budget screen and its flows", () => {
    const { group } = bound();
    recordGroupExpense(groupDeps(), {
      chatId: CHAT,
      sender: sender(4004, 'Борис'),
      text: '300 такси',
      sourceKey: 'tg:-100500:2',
      occurredAt: OCT_1,
      now: OCT_1,
    });
    const member = provisionUser(deps, {
      provider: 'telegram',
      externalId: '4004',
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD',
      now: OCT_1,
    }).user;

    expect(budgetScreen(deps, { user: member, ledgerId: group.id, now: OCT_1 })).toBeUndefined();
    const flow = { kind: 'budgetLimit', ledgerId: group.id } as const;
    expect(startBudgetFlow(deps, { user: member, flow, now: OCT_1 })).toBe(false);
    expect(
      setScope(deps, { user: member, ledgerId: group.id, scope: 'optional', now: OCT_1 }),
    ).toEqual({ kind: 'forbidden' });
  });

  it('reads nothing for an unbound chat', () => {
    expect(groupBudgetStatus(deps, { chatId: -1, now: OCT_1 })).toBeUndefined();
  });
});

describe('the limit flow', () => {
  it('refuses an expense, an ambiguous amount and a limit beyond the safe range', () => {
    expect(setLimit('450 кофе')).toMatchObject({ kind: 'invalid', reason: 'expenseShaped' });
    expect(setLimit('30.000')).toMatchObject({ kind: 'invalid', reason: 'ambiguousAmount' });
    // 3e14 minor parses, but 3e14 * 31 is past Number.MAX_SAFE_INTEGER.
    expect(setLimit('3000000000000')).toMatchObject({ kind: 'invalid', reason: 'tooLarge' });
    expect(setLimit('тридцать')).toMatchObject({ kind: 'invalid', reason: 'invalidAmount' });
    expect(status(OCT_1)).toBeUndefined();
  });

  it('adopts the ledger default currency of the time it is set', () => {
    setLimit('30000');
    db.prepare("UPDATE ledgers SET default_currency = 'EUR'").run();
    const eurLedger = { ...ledger, defaultCurrency: 'EUR' as const };
    expect(plain(memberBudgetStatus(deps, { user, ledger: eurLedger, now: OCT_1 }))?.currency).toBe(
      'RUB',
    );

    ledger = eurLedger;
    setLimit('1000');
    expect(status(OCT_1)).toMatchObject({ currency: 'EUR', limit: { limitMinor: 100_000 } });
  });
});
