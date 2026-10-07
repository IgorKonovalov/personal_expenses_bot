import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CategoryId } from '../../db/categories.js';
import {
  insertExpenseOrGetExisting,
  softDeleteExpense,
  type ExpenseId,
} from '../../db/expenses.js';
import { setFxDay, storeFxList } from '../../db/fxRates.js';
import type { LedgerId } from '../../db/ledgers.js';
import { insertReceiptItems } from '../../db/receiptItems.js';
import { insertReceipt, markReceiptFetched, type ReceiptId } from '../../db/receipts.js';
import { findUserByIdentity } from '../../db/users.js';
import { monthOf, weekOf } from '../../domain/periods.js';
import type { CurrencyCode } from '../../domain/currencies.js';
import type { LocalDate } from '../../domain/time.js';
import { createLogger } from '../../logger.js';
import { FLOW_TTL_MS } from '../../services/flowSessions.js';
import { sealPersonalLedger } from '../../services/testing/sealLedger.js';
import { drillExpenseData, drillListData, drillPickerData } from '../callbackData.js';
import { messages } from '../messages.js';
import { htmlParseMode } from '../render/html.js';
import {
  ALLOWED_ID,
  SECOND_ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  groupTextUpdate,
  myChatMemberUpdate,
  textUpdate,
  withMessageIds,
  type ApiCall,
} from '../testHarness.js';

// Wednesday 30 September 2026, 12:00 in Belgrade.
const NOW = new Date('2026-09-30T10:00:00Z');

// A fixture expense's id: a UUID, as the number buttons carry one.
const eid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}` as ExpenseId;

async function drillBot() {
  const harness = createTestBot({ now: NOW });
  withMessageIds(harness.bot, 100);
  const { bot, db } = harness;
  let updateId = 0;
  const say = (text: string, fromId = ALLOWED_ID, date = NOW) =>
    bot.handleUpdate(textUpdate({ updateId: ++updateId, messageId: updateId, text, fromId, date }));
  const tap = (data: string, messageId: number, fromId = ALLOWED_ID) =>
    bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data, messageId, fromId }));
  await say('/start');
  const user = findUserByIdentity(db, 'telegram', String(ALLOWED_ID));
  if (user === undefined) throw new Error('user not provisioned');
  const ledgerId = db
    .prepare('SELECT active_ledger_id FROM users WHERE id = ?')
    .pluck()
    .get(user.id) as LedgerId;
  const categoryOf = (preset: string, ledger: LedgerId = ledgerId) =>
    db
      .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
      .pluck()
      .get(ledger, preset) as CategoryId;
  const add = (
    n: number,
    occurredOn: string,
    amountMinor: number,
    currency: CurrencyCode,
    categoryId: CategoryId | null,
    description = `трата ${n}`,
  ) =>
    insertExpenseOrGetExisting(db, {
      id: eid(n),
      ledgerId,
      createdBy: user.id,
      amountMinor,
      currency,
      description,
      // Later numbers are later instants, so a day's expenses list highest number first.
      occurredAt: new Date(NOW.getTime() - 1_000_000 + n * 1000),
      occurredOn: occurredOn as LocalDate,
      sourceKey: `fixture:${n}`,
      createdAt: NOW,
      ...(categoryId === null ? {} : { categoryId }),
    });
  const anchor = () =>
    db
      .prepare('SELECT anchor_message_id FROM flow_sessions WHERE user_id = ?')
      .pluck()
      .get(user.id) as number;
  const screen = () =>
    db.prepare('SELECT screen, screen_ctx FROM flow_sessions WHERE user_id = ?').get(user.id) as {
      screen: string;
      screen_ctx: string;
    };
  harness.calls.length = 0;
  return { ...harness, say, tap, user, ledgerId, categoryOf, add, anchor, screen };
}

type Button = { text: string; callback_data?: string };

const button = (text: string, callback_data: string): Button => ({ text, callback_data });

function lastEdit(calls: readonly ApiCall[]) {
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1);
  return edit?.payload as
    { message_id: number; text: string; reply_markup: { inline_keyboard: Button[][] } } | undefined;
}

function sentKeyboard(calls: readonly ApiCall[]) {
  const sent = calls.filter((c) => c.method === 'sendMessage').at(-1);
  return (sent?.payload as { reply_markup: { inline_keyboard: Button[][] } }).reply_markup
    .inline_keyboard;
}

const SEPTEMBER = monthOf('2026-09-30' as LocalDate);

describe('[По категориям] on the summary', () => {
  it('sits beside [Позиции] under the pager, and is absent for a period with no expenses', async () => {
    const { say, tap, calls, add, categoryOf, anchor } = await drillBot();
    add(1, '2026-09-15', 120000, 'RSD', categoryOf('groceries'));

    await say('/month');

    expect(sentKeyboard(calls)).toEqual([
      [button('◀ Август', 'sum:m:2026-08')],
      [button('По категориям', 'drl:p:m:2026-09:1'), button('Позиции', 'itm:m:2026-09:1')],
    ]);

    calls.length = 0;
    await tap('sum:m:2026-08', anchor());

    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toEqual([
      [button('◀ Июль', 'sum:m:2026-07'), button('Сентябрь ▶', 'sum:m:2026-09')],
      [button('Позиции', 'itm:m:2026-08:1')],
    ]);
  });
});

describe('the category picker', () => {
  it('follows the digest: Продукты and Кафе once each, with KZT Продукты in its own block', async () => {
    const { say, tap, calls, add, categoryOf, anchor, screen, ledgerId } = await drillBot();
    add(1, '2026-09-10', 120000, 'RSD', categoryOf('groceries'));
    add(2, '2026-09-11', 45000, 'RSD', categoryOf('cafe'));
    add(3, '2026-09-12', 500000, 'KZT', categoryOf('groceries'));
    await say('/month');
    calls.length = 0;

    await tap('drl:p:m:2026-09:1', anchor());

    expect(lastEdit(calls)).toEqual({
      chat_id: ALLOWED_ID,
      message_id: anchor(),
      text:
        '<b>Сентябрь 2026 — «Личные расходы»</b>\n\n' +
        '<b>1 650.00 RSD</b>\nПродукты: 1 200.00\nКафе и рестораны: 450.00\n\n' +
        '<b>5 000.00 KZT</b>\nПродукты: 5 000.00\n\n' +
        'Выберите категорию, чтобы увидеть её траты.',
      reply_markup: {
        inline_keyboard: [
          [
            button('Продукты', `drl:c:m:2026-09:${categoryOf('groceries')}:1`),
            button('Кафе и рестораны', `drl:c:m:2026-09:${categoryOf('cafe')}:1`),
          ],
          [button('« Назад', 'sum:m:2026-09')],
        ],
      },
      ...htmlParseMode,
    });
    expect(screen()).toEqual({
      screen: 'summary',
      screen_ctx: JSON.stringify({
        ledgerId,
        drill: { level: 'picker', period: { kind: 'month', key: '2026-09' }, page: 1 },
      }),
    });
  });

  it("goes back to the same period's digest and clears the drill-down", async () => {
    const { say, tap, calls, add, categoryOf, anchor, screen, ledgerId } = await drillBot();
    add(1, '2026-08-10', 120000, 'RSD', categoryOf('groceries'));
    await say('/month');
    await tap('sum:m:2026-08', anchor());
    await tap('drl:p:m:2026-08:1', anchor());
    calls.length = 0;

    await tap('sum:m:2026-08', anchor());

    expect(lastEdit(calls)?.text).toBe(
      '<b>Август 2026 — «Личные расходы»</b>\n\n<b>1 200.00 RSD</b>\n' +
        '<blockquote expandable>Продукты: 1 200.00</blockquote>',
    );
    expect(screen().screen_ctx).toBe(JSON.stringify({ ledgerId }));
  });
});

describe('the expense list', () => {
  it('numbers the newest first, escaped and cut to 40 characters, under the totals', async () => {
    const { db, say, tap, calls, add, categoryOf, anchor, screen, ledgerId } = await drillBot();
    const groceries = categoryOf('groceries');
    add(1, '2026-09-15', 120000, 'RSD', groceries, 'хлеб <и> молоко');
    add(2, '2026-09-28', 1250, 'EUR', groceries, 'я'.repeat(45));
    add(3, '2026-08-31', 99900, 'RSD', groceries);
    add(4, '2026-09-20', 77700, 'RSD', groceries);
    softDeleteExpense(db, eid(4), NOW);
    add(5, '2026-09-21', 33300, 'RSD', categoryOf('cafe'));
    await say('/month');
    calls.length = 0;

    await tap(drillListData(SEPTEMBER, groceries, 1), anchor());

    expect(lastEdit(calls)?.text).toBe(
      '<b>Продукты · сентябрь 2026</b>\n' +
        '«Личные расходы» · 2 траты · 1 200.00 RSD, 12.50 EUR\n\n' +
        `1. 28 сен — 12.50 EUR · ${'я'.repeat(40)}…\n` +
        '2. 15 сен — 1 200.00 RSD · хлеб &lt;и&gt; молоко',
    );
    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toEqual([
      [button('1', `drl:e:${eid(2)}`), button('2', `drl:e:${eid(1)}`)],
      [button('« Назад', 'drl:p:m:2026-09:1')],
    ]);
    expect(JSON.parse(screen().screen_ctx)).toEqual({
      ledgerId,
      drill: {
        level: 'list',
        period: { kind: 'month', key: '2026-09' },
        categoryId: groceries,
        page: 1,
      },
    });
  });

  it('lists the uncategorized expenses under Без категории', async () => {
    const { say, tap, calls, add, anchor } = await drillBot();
    add(1, '2026-09-15', 7000, 'RSD', null, 'разное');
    await say('/month');
    calls.length = 0;

    await tap('drl:c:m:2026-09:n:1', anchor());

    expect(lastEdit(calls)?.text).toBe(
      '<b>Без категории · сентябрь 2026</b>\n«Личные расходы» · 1 трата · 70.00 RSD\n\n' +
        '1. 15 сен — 70.00 RSD · разное',
    );
  });

  it('pages 19 expenses as 8, 8 and 3: page 3 shows lines 17 to 19', async () => {
    const { say, tap, calls, add, categoryOf, anchor } = await drillBot();
    const cafe = categoryOf('cafe');
    // Number 19 is the newest, so line k holds expense 20 - k.
    for (let n = 1; n <= 19; n++)
      add(n, `2026-09-${String(n).padStart(2, '0')}`, 10000, 'RSD', cafe);
    await say('/month');
    calls.length = 0;

    await tap(drillListData(SEPTEMBER, cafe, 3), anchor());

    const edit = lastEdit(calls);
    expect(edit?.text).toBe(
      '<b>Кафе и рестораны · сентябрь 2026</b>\n«Личные расходы» · 19 трат · 1 900.00 RSD\n\n' +
        '17. 3 сен — 100.00 RSD · трата 3\n' +
        '18. 2 сен — 100.00 RSD · трата 2\n' +
        '19. 1 сен — 100.00 RSD · трата 1',
    );
    expect(edit?.reply_markup.inline_keyboard).toEqual([
      [
        button('17', `drl:e:${eid(3)}`),
        button('18', `drl:e:${eid(2)}`),
        button('19', `drl:e:${eid(1)}`),
      ],
      [
        button('◀', drillListData(SEPTEMBER, cafe, 2)),
        button('3/3', drillListData(SEPTEMBER, cafe, 3)),
      ],
      [button('« Назад', 'drl:p:m:2026-09:1')],
    ]);

    calls.length = 0;
    await tap(drillListData(SEPTEMBER, cafe, 1), anchor());

    expect(lastEdit(calls)?.reply_markup.inline_keyboard.slice(0, 3)).toEqual([
      [19, 18, 17, 16].map((n, i) => button(String(i + 1), `drl:e:${eid(n)}`)),
      [15, 14, 13, 12].map((n, i) => button(String(i + 5), `drl:e:${eid(n)}`)),
      [
        button('1/3', drillListData(SEPTEMBER, cafe, 1)),
        button('▶', drillListData(SEPTEMBER, cafe, 2)),
      ],
    ]);
  });

  it('goes back to the picker page holding the category: the 10th of 12 is on page 2', async () => {
    const { db, say, tap, calls, add, anchor, ledgerId } = await drillBot();
    const ids: CategoryId[] = [];
    for (let k = 1; k <= 12; k++) {
      const name = `К${String(k).padStart(2, '0')}`;
      db.prepare(
        `INSERT INTO categories (ledger_id, name, name_key, preset_key, essential, created_at)
         VALUES (?, ?, ?, NULL, 0, ?)`,
      ).run(ledgerId, name, name.toLowerCase(), NOW.toISOString());
      const id = db
        .prepare('SELECT id FROM categories WHERE ledger_id = ? AND name = ?')
        .pluck()
        .get(ledgerId, name) as CategoryId;
      ids.push(id);
      // Larger amounts first, so the picker lists К01 to К12 in order.
      add(k, '2026-09-10', (13 - k) * 10000, 'RSD', id);
    }
    const tenth = ids[9] ?? null;
    await say('/month');
    calls.length = 0;

    await tap(drillListData(SEPTEMBER, tenth, 1), anchor());

    expect(lastEdit(calls)?.reply_markup.inline_keyboard.at(-1)).toEqual([
      button('« Назад', 'drl:p:m:2026-09:2'),
    ]);

    calls.length = 0;
    await tap('drl:p:m:2026-09:2', anchor());

    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toEqual([
      [
        button('К09', drillListData(SEPTEMBER, ids[8] ?? null, 1)),
        button('К10', drillListData(SEPTEMBER, tenth, 1)),
      ],
      [
        button('К11', drillListData(SEPTEMBER, ids[10] ?? null, 1)),
        button('К12', drillListData(SEPTEMBER, ids[11] ?? null, 1)),
      ],
      [button('◀', 'drl:p:m:2026-09:1'), button('2/2', 'drl:p:m:2026-09:2')],
      [button('« Назад', 'sum:m:2026-09')],
    ]);
  });

  it('says a category every expense moved out of has none, with [« Назад] alone', async () => {
    const { db, say, tap, calls, add, categoryOf, anchor } = await drillBot();
    add(1, '2026-09-15', 120000, 'RSD', categoryOf('groceries'));
    add(2, '2026-09-16', 45000, 'RSD', categoryOf('cafe'));
    await say('/month');
    db.prepare('UPDATE expenses SET category_id = ? WHERE id = ?').run(categoryOf('cafe'), eid(1));
    calls.length = 0;

    await tap(drillListData(SEPTEMBER, categoryOf('groceries'), 1), anchor());

    expect(lastEdit(calls)?.text).toBe('В категории «Продукты» за сентябрь 2026 трат нет.');
    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toEqual([
      [button('« Назад', 'drl:p:m:2026-09:1')],
    ]);
  });

  it("names each expense's author in a shared ledger, dated in the ledger's zone", async () => {
    const { bot, db, say, tap, calls, user, anchor } = await drillBot();
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 900,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    const shared = db
      .prepare("SELECT id FROM ledgers WHERE kind = 'shared'")
      .pluck()
      .get() as LedgerId;
    db.prepare("UPDATE ledgers SET timezone = 'America/New_York' WHERE id = ?").run(shared);
    const group = (updateId: number, fromId: number, firstName: string, text: string, date: Date) =>
      bot.handleUpdate(
        groupTextUpdate({ updateId, fromId, firstName, text, messageId: updateId, date }),
      );
    // 22:00 on 29 September in New York, 04:00 on the 30th in Belgrade.
    await group(901, ALLOWED_ID, 'Анна', '450 кофе', new Date('2026-09-30T02:00:00Z'));
    await group(902, SECOND_ALLOWED_ID, 'Борис', '300 кофе', NOW);
    db.prepare('UPDATE ledger_members SET display_name = NULL WHERE user_id != ?').run(user.id);
    db.prepare('UPDATE users SET active_ledger_id = ? WHERE id = ?').run(shared, user.id);
    const cafe = db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .pluck()
      .get(shared) as CategoryId;
    await say('/month');
    calls.length = 0;

    await tap(drillListData(SEPTEMBER, cafe, 1), anchor());

    expect(lastEdit(calls)?.text).toBe(
      '<b>Кафе и рестораны · сентябрь 2026</b>\n«Семья» · 2 траты · 750.00 RSD\n\n' +
        '1. 30 сен — 300.00 RSD · кофе · участник\n' +
        '2. 29 сен — 450.00 RSD · кофе · Анна',
    );
  });
});

describe('drill-down guards', () => {
  async function openedList() {
    const bot = await drillBot();
    bot.add(1, '2026-09-15', 120000, 'RSD', bot.categoryOf('groceries'));
    await bot.say('/month');
    bot.calls.length = 0;
    return bot;
  }

  it('toasts staleScreen on a tap on a message that is not the anchor, and edits nothing', async () => {
    const { tap, calls, anchor, categoryOf } = await openedList();

    await tap('drl:p:m:2026-09:1', anchor() - 1);
    await tap(drillListData(SEPTEMBER, categoryOf('groceries'), 1), anchor() - 1);

    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) as string, text: messages.staleScreen },
      },
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) as string, text: messages.staleScreen },
      },
    ]);
  });

  it('toasts staleScreen once a newer screen took the anchor', async () => {
    const { say, tap, calls, anchor } = await openedList();
    const summary = anchor();
    await say('/categories');
    calls.length = 0;

    await tap('drl:p:m:2026-09:1', summary);

    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: expect.any(String) as string, text: messages.staleScreen },
      },
    ]);
  });

  it('toasts ledgerLockedToast for a ledger locked between taps, and edits nothing', async () => {
    const { db, keys, user, tap, calls, anchor, categoryOf } = await openedList();
    const groceries = categoryOf('groceries');
    const deps = { db, keys, logger: createLogger('silent'), newId: () => randomUUID() };
    const ledger = await sealPersonalLedger(deps, user, NOW);
    keys.lock(ledger.id);
    calls.length = 0;

    await tap('drl:p:m:2026-09:1', anchor());
    await tap(drillListData(SEPTEMBER, groceries, 1), anchor());

    const toast = {
      method: 'answerCallbackQuery',
      payload: {
        callback_query_id: expect.any(String) as string,
        text: messages.ledgerLockedToast,
      },
    };
    expect(calls).toEqual([toast, toast]);
  });

  it("answers a forged or future period and another ledger's category silently", async () => {
    const { db, tap, calls, anchor, categoryOf } = await openedList();
    const groceries = categoryOf('groceries');
    const foreign = (db.prepare('SELECT MAX(id) FROM categories').pluck().get() as number) + 1000;

    await tap('drl:p:m:2026-13:1', anchor());
    await tap('drl:p:m:2026-10:1', anchor());
    await tap(`drl:c:m:2026-13:${groceries}:1`, anchor());
    await tap(drillListData(weekOf('2026-10-05' as LocalDate), groceries, 1), anchor());
    await tap(`drl:c:m:2026-09:${foreign}:1`, anchor());

    expect(calls.map((c) => c.method)).toEqual(Array(5).fill('answerCallbackQuery'));
    expect(calls.every((c) => (c.payload as { text?: string }).text === undefined)).toBe(true);
  });

  it('answers a user who left the ledger silently', async () => {
    const { bot, db, user, say, tap, calls, anchor, ledgerId } = await drillBot();
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 900,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    await bot.handleUpdate(
      groupTextUpdate({ updateId: 901, text: '450 кофе', messageId: 901, date: NOW }),
    );
    const shared = db
      .prepare("SELECT id FROM ledgers WHERE kind = 'shared'")
      .pluck()
      .get() as LedgerId;
    const cafe = db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .pluck()
      .get(shared) as CategoryId;
    db.prepare('UPDATE users SET active_ledger_id = ? WHERE id = ?').run(shared, user.id);
    await say('/month');
    db.prepare('DELETE FROM ledger_members WHERE ledger_id = ? AND user_id = ?').run(
      shared,
      user.id,
    );
    db.prepare('UPDATE users SET active_ledger_id = ? WHERE id = ?').run(ledgerId, user.id);
    calls.length = 0;

    await tap('drl:p:m:2026-09:1', anchor());
    await tap(drillListData(SEPTEMBER, cafe, 1), anchor());

    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'answerCallbackQuery']);
    expect(calls.every((c) => (c.payload as { text?: string }).text === undefined)).toBe(true);
  });
});

describe('drill-down callback data', () => {
  it('builds the widest list data at 40 bytes, the picker at 23 and a number at 42', () => {
    const week = weekOf('2026-09-28' as LocalDate);

    const widest = drillListData(week, 9_007_199_254_740_991 as CategoryId, 9999);

    expect(widest).toBe('drl:c:w:2026-09-28:9007199254740991:9999');
    expect(Buffer.byteLength(widest)).toBe(40);
    expect(Buffer.byteLength(drillPickerData(week, 9999))).toBe(23);
    expect(Buffer.byteLength(drillExpenseData(eid(1)))).toBe(42);
  });
});

const BACK_ROW = [button('« Назад', 'drl:back')];

// Продукты holds 1: 1 200.00 RSD on the 15th and 2: 10.74 EUR on the 28th (≈ 1 261.94 RSD at the
// stored NBS rate); Кафе holds 3: 450.00 RSD. The receipt card cases add 4 and 5 to Продукты.
async function cardBot() {
  const bot = await drillBot();
  const day = '2026-09-28' as LocalDate;
  const fetchedAt = new Date('2026-09-28T08:00:00Z');
  storeFxList(
    bot.db,
    { listDate: day, listNumber: 184, rates: [{ currency: 'EUR', unit: 1, middleE4: 1174993 }] },
    fetchedAt,
  );
  setFxDay(bot.db, day, day, fetchedAt);
  const groceries = bot.categoryOf('groceries');
  const cafe = bot.categoryOf('cafe');
  bot.add(1, '2026-09-15', 120000, 'RSD', groceries, 'хлеб');
  bot.add(2, '2026-09-28', 1074, 'EUR', groceries, 'сыр');
  bot.add(3, '2026-09-20', 45000, 'RSD', cafe, 'кофе');
  // Opens Продукты's list, then expense n's card from it.
  const openCard = async (n: number) => {
    await bot.say('/month');
    await bot.tap(drillListData(SEPTEMBER, groceries, 1), bot.anchor());
    await bot.tap(drillExpenseData(eid(n)), bot.anchor());
  };
  bot.calls.length = 0;
  return { ...bot, groceries, cafe, openCard };
}

function receiptFor(
  db: Awaited<ReturnType<typeof drillBot>>['db'],
  n: number,
  state: 'fetched' | 'failed',
) {
  const id = `rrrrrrrr-0000-4000-8000-${String(n).padStart(12, '0')}` as ReceiptId;
  insertReceipt(db, {
    id,
    expenseId: eid(n),
    country: 'RS',
    fiscalId: `FISCAL-${n}`,
    merchantKey: 'rs:test',
    verifyUrl: `https://example.test/v/${n}`,
    issuedAt: NOW,
    createdAt: NOW,
  });
  if (state === 'fetched') {
    markReceiptFetched(db, id, 'Test Market');
    insertReceiptItems(db, id, [{ name: 'Хлеб', quantity: '1', totalMinor: 120000 }]);
  } else {
    db.prepare("UPDATE receipts SET fetch_state = 'failed', next_fetch_at = NULL WHERE id = ?").run(
      id,
    );
  }
}

describe('the card in the drill-down (ADR-0040)', () => {
  it('opens the real card in the anchor with [« Назад] on its own bottom row', async () => {
    const { calls, openCard, anchor, screen, ledgerId, groceries } = await cardBot();

    await openCard(1);

    const card = lastEdit(calls);
    expect(card?.message_id).toBe(anchor());
    expect(card?.text).toBe(
      'Записано в «Личные расходы» за 15 сентября: <b>1 200.00 RSD</b> — хлеб · Продукты',
    );
    expect(card?.reply_markup.inline_keyboard).toEqual([
      [button('Категория', `exp:cat:${eid(1)}`), button('Изменить', `exp:edit:${eid(1)}`)],
      [button('Повторять', `rec:new:${eid(1)}`)],
      [button('Удалить', `exp:undo:${eid(1)}`)],
      BACK_ROW,
    ]);
    expect(JSON.parse(screen().screen_ctx)).toEqual({
      ledgerId,
      drill: {
        level: 'list',
        period: { kind: 'month', key: '2026-09' },
        categoryId: groceries,
        page: 1,
        expenseId: eid(1),
      },
    });
  });

  it('toasts staleScreen for [n] off the anchor or while the anchor shows no list', async () => {
    const { say, tap, calls, anchor } = await cardBot();
    await say('/month');
    await tap('drl:p:m:2026-09:1', anchor());
    calls.length = 0;

    await tap(drillExpenseData(eid(1)), anchor());
    await tap(drillExpenseData(eid(1)), anchor() - 1);

    const stale = {
      method: 'answerCallbackQuery',
      payload: { callback_query_id: expect.any(String) as string, text: messages.staleScreen },
    };
    expect(calls).toEqual([stale, stale]);
  });

  it("toasts expenseNotFound for another ledger's expense or none, and edits nothing", async () => {
    const { bot, db, say, tap, calls, anchor, groceries } = await cardBot();
    // The user's own expense, but in the group's shared ledger, not the screen's.
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 900,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    await bot.handleUpdate(
      groupTextUpdate({ updateId: 901, text: '300 кофе', messageId: 901, date: NOW }),
    );
    const groupExpense = db
      .prepare(
        "SELECT e.id FROM expenses e JOIN ledgers l ON l.id = e.ledger_id WHERE l.kind = 'shared'",
      )
      .pluck()
      .get() as ExpenseId;
    await say('/month');
    await tap(drillListData(SEPTEMBER, groceries, 1), anchor());
    calls.length = 0;

    await tap(drillExpenseData(groupExpense), anchor());
    await tap(drillExpenseData(eid(91)), anchor());

    const notFound = {
      method: 'answerCallbackQuery',
      payload: { callback_query_id: expect.any(String) as string, text: messages.expenseNotFound },
    };
    expect(calls).toEqual([notFound, notFound]);
  });

  it("shows another member's expense with [« Назад] as its only button", async () => {
    const { bot, db, say, tap, calls, user, anchor } = await drillBot();
    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 900,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    await bot.handleUpdate(
      groupTextUpdate({
        updateId: 901,
        fromId: SECOND_ALLOWED_ID,
        firstName: 'Борис',
        text: '300 кофе',
        messageId: 901,
        date: NOW,
      }),
    );
    const shared = db
      .prepare("SELECT id FROM ledgers WHERE kind = 'shared'")
      .pluck()
      .get() as LedgerId;
    const cafe = db
      .prepare("SELECT id FROM categories WHERE ledger_id = ? AND preset_key = 'cafe'")
      .pluck()
      .get(shared) as CategoryId;
    const borisExpense = db
      .prepare('SELECT id FROM expenses WHERE ledger_id = ?')
      .pluck()
      .get(shared) as ExpenseId;
    db.prepare('UPDATE users SET active_ledger_id = ? WHERE id = ?').run(shared, user.id);
    await say('/month');
    await tap(drillListData(SEPTEMBER, cafe, 1), anchor());
    calls.length = 0;

    await tap(drillExpenseData(borisExpense), anchor());

    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toEqual([BACK_ROW]);
  });
});

describe('the back row survives every card action on the anchor', () => {
  const lastRow = (calls: readonly ApiCall[]) =>
    lastEdit(calls)?.reply_markup.inline_keyboard.at(-1);

  it('after a category change and after the picker’s [« Назад] (exp:show)', async () => {
    const { tap, calls, openCard, anchor, cafe } = await cardBot();
    await openCard(1);

    await tap(`exp:cat:${eid(1)}`, anchor());
    calls.length = 0;
    await tap(`exp:show:${eid(1)}`, anchor());
    expect(lastRow(calls)).toEqual(BACK_ROW);

    calls.length = 0;
    await tap(`exp:setcat:${eid(1)}:${cafe}`, anchor());
    expect(lastEdit(calls)?.text).toContain('Кафе и рестораны');
    expect(lastRow(calls)).toEqual(BACK_ROW);
  });

  it('after delete and after restore', async () => {
    const { tap, calls, openCard, anchor } = await cardBot();
    await openCard(1);

    calls.length = 0;
    await tap(`exp:undo:${eid(1)}`, anchor());
    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toEqual([
      [button('Вернуть', `exp:restore:${eid(1)}`)],
      BACK_ROW,
    ]);

    calls.length = 0;
    await tap(`exp:restore:${eid(1)}`, anchor());
    expect(lastRow(calls)).toEqual(BACK_ROW);
  });

  it('after the date quick button', async () => {
    const { tap, calls, openCard, anchor } = await cardBot();
    await openCard(1);
    calls.length = 0;

    await tap(`exp:dt:${eid(1)}:2026-09-29`, anchor());

    expect(lastEdit(calls)?.text).toContain('29 сентября');
    expect(lastRow(calls)).toEqual(BACK_ROW);
  });

  it("after the receipt items' [« Назад] and after [Повторить]", async () => {
    const { db, add, tap, calls, openCard, anchor, groceries } = await cardBot();
    add(4, '2026-09-29', 120000, 'RSD', groceries, 'Чек');
    receiptFor(db, 4, 'fetched');
    add(5, '2026-09-29', 50000, 'RSD', groceries, 'Чек');
    receiptFor(db, 5, 'failed');

    await openCard(4);
    await tap(`exp:items:${eid(4)}:1`, anchor());
    calls.length = 0;
    await tap(`exp:show:${eid(4)}`, anchor());
    expect(lastRow(calls)).toEqual(BACK_ROW);

    await openCard(5);
    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toContainEqual([
      button('Повторить', `exp:rcretry:${eid(5)}`),
    ]);
    calls.length = 0;
    await tap(`exp:rcretry:${eid(5)}`, anchor());
    expect(lastRow(calls)).toEqual(BACK_ROW);
  });

  it("after repeat's [« Назад] and after picking a schedule", async () => {
    const { tap, calls, openCard, anchor } = await cardBot();
    await openCard(1);

    await tap(`rec:new:${eid(1)}`, anchor());
    calls.length = 0;
    await tap(`exp:show:${eid(1)}`, anchor());
    expect(lastRow(calls)).toEqual(BACK_ROW);

    calls.length = 0;
    await tap(`rec:s:${eid(1)}:m`, anchor());
    expect(lastRow(calls)).toEqual(BACK_ROW);
  });
});

describe('old cards are unchanged', () => {
  // The drill-down card of expense 1 holds the anchor; each action is tapped on its confirmation,
  // another message, which gets no back row.
  const CONFIRMATION = 7;

  it.each([
    ['set category', (cafe: CategoryId) => `exp:setcat:${eid(1)}:${cafe}`],
    ['show the card', () => `exp:show:${eid(1)}`],
    ['delete', () => `exp:undo:${eid(1)}`],
    ['the date quick button', () => `exp:dt:${eid(1)}:2026-09-29`],
    ['repeat', () => `rec:s:${eid(1)}:m`],
  ])('%s on a confirmation that is not the anchor carries no drl:back', async (_, data) => {
    const { tap, calls, openCard, cafe } = await cardBot();
    await openCard(1);
    calls.length = 0;

    await tap(data(cafe), CONFIRMATION);

    expect(lastEdit(calls)?.message_id).toBe(CONFIRMATION);
    expect(JSON.stringify(calls)).not.toContain('drl:back');
  });

  it('restore and [Повторить] on a confirmation carry no drl:back', async () => {
    const { db, add, tap, calls, openCard, groceries } = await cardBot();
    add(5, '2026-09-29', 50000, 'RSD', groceries, 'Чек');
    receiptFor(db, 5, 'failed');
    await openCard(1);
    await tap(`exp:undo:${eid(1)}`, CONFIRMATION);
    calls.length = 0;

    await tap(`exp:restore:${eid(1)}`, CONFIRMATION);
    await tap(`exp:rcretry:${eid(5)}`, CONFIRMATION);

    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toContain('drl:back');
  });
});

describe('back from the card to the list', () => {
  it('re-reads Продукты without an expense moved to Кафе, its total lower by that expense', async () => {
    const { say, tap, calls, anchor, cafe, groceries } = await cardBot();
    await say('/month');
    await tap(drillListData(SEPTEMBER, groceries, 1), anchor());
    const before = lastEdit(calls)?.text;
    await tap(drillExpenseData(eid(2)), anchor());
    await tap(`exp:setcat:${eid(2)}:${cafe}`, anchor());
    calls.length = 0;

    await tap('drl:back', anchor());

    // 1 200.00 + 1 261.94 (10.74 EUR at 117.4993) before; 1 200.00 after.
    expect(before).toContain('«Личные расходы» · 2 траты · ≈ 2 461.94 RSD');
    expect(lastEdit(calls)?.text).toBe(
      '<b>Продукты · сентябрь 2026</b>\n«Личные расходы» · 1 трата · 1 200.00 RSD\n\n' +
        '1. 15 сен — 1 200.00 RSD · хлеб',
    );
    expect(lastEdit(calls)?.reply_markup.inline_keyboard).toEqual([
      [button('1', `drl:e:${eid(1)}`)],
      [button('« Назад', 'drl:p:m:2026-09:1')],
    ]);
  });

  it('shows the list without a deleted expense', async () => {
    const { tap, calls, openCard, anchor } = await cardBot();
    await openCard(1);
    await tap(`exp:undo:${eid(1)}`, anchor());
    calls.length = 0;

    await tap('drl:back', anchor());

    expect(lastEdit(calls)?.text).toBe(
      '<b>Продукты · сентябрь 2026</b>\n«Личные расходы» · 1 трата · ≈ 1 261.94 RSD\n\n' +
        '1. 28 сен — 10.74 EUR · сыр',
    );
  });

  it('shows the last page that still exists once the last expense of the last page moved out', async () => {
    const { add, say, tap, calls, anchor, categoryOf } = await drillBot();
    const groceries = categoryOf('groceries');
    const cafe = categoryOf('cafe');
    for (let n = 1; n <= 9; n++) add(n, `2026-09-0${n}`, 10000, 'RSD', groceries);
    await say('/month');
    await tap(drillListData(SEPTEMBER, groceries, 2), anchor());
    // Page 2 holds line 9 alone: expense 1, the oldest.
    await tap(drillExpenseData(eid(1)), anchor());
    await tap(`exp:setcat:${eid(1)}:${cafe}`, anchor());
    calls.length = 0;

    await tap('drl:back', anchor());

    expect(lastEdit(calls)?.text).toContain('«Личные расходы» · 8 трат');
    expect(lastEdit(calls)?.reply_markup.inline_keyboard.slice(0, 2)).toEqual([
      [9, 8, 7, 6].map((n, i) => button(String(i + 1), `drl:e:${eid(n)}`)),
      [5, 4, 3, 2].map((n, i) => button(String(i + 5), `drl:e:${eid(n)}`)),
    ]);
  });
});

describe('edit prompts from the drill-down card (ADR-0040)', () => {
  // Expense 1's card from Продукты's list, turned into its `field` prompt.
  async function promptBot(field: 'a' | 't') {
    const bot = await cardBot();
    await bot.openCard(1);
    await bot.tap(`exp:edit:${eid(1)}`, bot.anchor());
    await bot.tap(`exp:ef:${eid(1)}:${field}`, bot.anchor());
    bot.calls.length = 0;
    return bot;
  }

  const drillWithCard = (ledgerId: LedgerId, groceries: CategoryId) => ({
    ledgerId,
    drill: {
      level: 'list',
      period: { kind: 'month', key: '2026-09' },
      categoryId: groceries,
      page: 1,
      expenseId: eid(1),
    },
  });

  // The anchor is the summary screen again, holding expense 1's card, which ends on [« Назад].
  function expectBackInDrill(bot: Awaited<ReturnType<typeof promptBot>>) {
    expect(bot.screen().screen).toBe('summary');
    expect(JSON.parse(bot.screen().screen_ctx)).toEqual(drillWithCard(bot.ledgerId, bot.groceries));
    const card = lastEdit(bot.calls);
    expect(card?.message_id).toBe(bot.anchor());
    expect(card?.reply_markup.inline_keyboard.at(-1)).toEqual(BACK_ROW);
  }

  it('keeps the summary screen in the prompt’s returnTo', async () => {
    const bot = await promptBot('a');

    expect(bot.screen().screen).toBe('expense');
    expect(JSON.parse(bot.screen().screen_ctx)).toEqual({
      expenseId: eid(1),
      returnTo: { name: 'summary', ...drillWithCard(bot.ledgerId, bot.groceries) },
    });
  });

  it('returns to the drill-down after a valid amount', async () => {
    const bot = await promptBot('a');

    await bot.say('999');

    expect(lastEdit(bot.calls)?.text).toContain('<b>999.00 RSD</b> — хлеб');
    expectBackInDrill(bot);
  });

  it('returns to the drill-down after /cancel', async () => {
    const bot = await promptBot('a');

    await bot.say('/cancel');

    expectBackInDrill(bot);
  });

  it('returns to the drill-down after [Отмена]', async () => {
    const bot = await promptBot('a');

    await bot.tap(`exp:show:${eid(1)}`, bot.anchor());

    expectBackInDrill(bot);
  });

  it('returns to the drill-down when the expense was deleted mid-prompt', async () => {
    const bot = await promptBot('a');
    softDeleteExpense(bot.db, eid(1), NOW);

    await bot.say('999');

    expect(bot.calls.some((c) => (c.payload as { text?: string }).text === messages.editGone)).toBe(
      true,
    );
    expect(lastEdit(bot.calls)?.reply_markup.inline_keyboard).toEqual([
      [button('Вернуть', `exp:restore:${eid(1)}`)],
      BACK_ROW,
    ]);
    expectBackInDrill(bot);
  });

  it('goes back to the list from a prompt left past FLOW_TTL_MS', async () => {
    const bot = await promptBot('a');
    bot.db
      .prepare('UPDATE flow_sessions SET expires_at = ? WHERE user_id = ?')
      .run(new Date(NOW.getTime() - FLOW_TTL_MS).toISOString(), bot.user.id);

    await bot.tap('drl:back', bot.anchor());

    expect(lastEdit(bot.calls)?.text).toBe(
      '<b>Продукты · сентябрь 2026</b>\n«Личные расходы» · 2 траты · ≈ 2 461.94 RSD\n\n' +
        '1. 28 сен — 10.74 EUR · сыр\n2. 15 сен — 1 200.00 RSD · хлеб',
    );
    const { drill } = JSON.parse(bot.screen().screen_ctx) as { drill: object };
    expect(bot.screen().screen).toBe('summary');
    expect(drill).toEqual({
      level: 'list',
      period: { kind: 'month', key: '2026-09' },
      categoryId: bot.groceries,
      page: 1,
    });
  });

  it('shows the list without an expense a date edit moved out of the period', async () => {
    const bot = await promptBot('t');

    await bot.say('25.08');
    expectBackInDrill(bot);
    bot.calls.length = 0;
    await bot.tap('drl:back', bot.anchor());

    expect(lastEdit(bot.calls)?.text).toBe(
      '<b>Продукты · сентябрь 2026</b>\n«Личные расходы» · 1 трата · ≈ 1 261.94 RSD\n\n' +
        '1. 28 сен — 10.74 EUR · сыр',
    );
  });

  it('stores no returnTo for an edit from an ordinary confirmation, whose card has no back row', async () => {
    const { db, say, tap, calls, screen } = await drillBot();
    await say('450 кофе');
    // A card action works on whichever message carries it; this one stands for the confirmation.
    const confirmation = 7;
    const expenseId = db
      .prepare("SELECT id FROM expenses WHERE description = 'кофе'")
      .pluck()
      .get() as ExpenseId;
    await tap(`exp:ef:${expenseId}:a`, confirmation);

    expect(screen()).toEqual({
      screen: 'expense',
      screen_ctx: JSON.stringify({ expenseId }),
    });

    calls.length = 0;
    await say('500');

    expect(lastEdit(calls)?.message_id).toBe(confirmation);
    expect(JSON.stringify(calls)).not.toContain('drl:back');
  });
});
