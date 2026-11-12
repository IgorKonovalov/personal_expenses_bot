import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { renameCategory, type CategoryId } from '../../db/categories.js';
import { openDatabase } from '../../db/connection.js';
import { insertExpenseOrGetExisting, type ExpenseId } from '../../db/expenses.js';
import type { LedgerId } from '../../db/ledgers.js';
import { runMigrations } from '../../db/migrate.js';
import { findUserByIdentity } from '../../db/users.js';
import { MAX_CATEGORY_NAME, categoryNameKey } from '../../domain/categories.js';
import type { CurrencyCode } from '../../domain/currencies.js';
import type { LocalDate } from '../../domain/time.js';
import { utf8Bytes } from '../../domain/widgetData.js';
import { createLogger } from '../../logger.js';
import { admitTelegramIds, setBlocked } from '../../services/admission.js';
import { createLedgerKeyring } from '../../services/ledgerKeys.js';
import { sealPersonalLedger } from '../../services/testing/sealLedger.js';
import { createBot } from '../bot.js';
import { messages } from '../messages.js';
import {
  ALLOWED_ID,
  SECOND_ALLOWED_ID,
  STRANGER_ID,
  quietFirstContact,
  textUpdate,
  type ApiCall,
} from '../testHarness.js';

// Thursday 12 November 2026, 14:05 in Belgrade (CET, UTC+1).
const NOW = new Date('2026-11-12T13:05:00Z');

// A widget_query update as Bot API 10.4 delivers it; grammY's types don't know it yet.
function widgetQueryUpdate(
  updateId: number,
  queryId: string,
  data: string,
  fromId = ALLOWED_ID,
): Update {
  const query = {
    id: queryId,
    from: { id: fromId, is_bot: false, first_name: 'Test' },
    chat: { id: fromId, type: 'private', first_name: 'Test' },
    message_id: 300,
    chat_instance: 'test',
    type: { type: 'data' },
    data,
  };
  return { update_id: updateId, widget_query: query } as unknown as Update;
}

async function queryBot() {
  const db = openDatabase(':memory:');
  runMigrations(db, NOW);
  quietFirstContact(db);
  let ids = 0;
  let messageId = 100;
  const keys = createLedgerKeyring(() => NOW);
  const deps = {
    db,
    logger: createLogger('silent'),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    now: () => NOW,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD' as CurrencyCode,
    adminTelegramId: ALLOWED_ID,
    keys,
  };
  const bot = createBot({
    ...deps,
    token: '123456:test-token',
    backupKeep: 14,
    widgets: true,
    botInfo: {
      id: 42,
      is_bot: true,
      first_name: 'Test Bot',
      username: 'test_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  const calls: ApiCall[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    const chat = { id: (payload as { chat_id?: number }).chat_id, type: 'private' };
    const result =
      method === 'sendMessage' ? { message_id: ++messageId, date: 0, chat, text: '' } : true;
    return Promise.resolve({ ok: true, result: result as never });
  });
  let updateId = 0;
  const say = (text: string, fromId = ALLOWED_ID, date = NOW) =>
    bot.handleUpdate(textUpdate({ updateId: ++updateId, text, fromId, date }));
  // The n-th query is `wq-<n>`.
  let queries = 0;
  const ask = (data: string, fromId = ALLOWED_ID) =>
    bot.handleUpdate(widgetQueryUpdate(++updateId, `wq-${++queries}`, data, fromId));
  const answers = () =>
    calls.filter((call) => call.method === 'answerWidgetQuery').map((call) => call.payload);

  // A user's ids once /start has provisioned them.
  async function join(telegramId: number) {
    if (telegramId !== ALLOWED_ID) admitTelegramIds(deps, [telegramId], NOW);
    await say('/start', telegramId);
    const user = findUserByIdentity(db, 'telegram', String(telegramId));
    if (user === undefined) throw new Error('setup: no user');
    const ledgerId = db
      .prepare('SELECT active_ledger_id FROM users WHERE id = ?')
      .pluck()
      .get(user.id) as LedgerId;
    const categoryOf = (preset: string) =>
      db
        .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
        .pluck()
        .get(ledgerId, preset) as CategoryId;
    let n = 0;
    const add = (occurredOn: string, amountMinor: number, preset: string) =>
      insertExpenseOrGetExisting(db, {
        id: `00000000-0000-4000-9000-${String(telegramId).padStart(6, '0')}${String(++n).padStart(6, '0')}` as ExpenseId,
        ledgerId,
        createdBy: user.id,
        amountMinor,
        currency: 'RSD',
        description: 'x',
        occurredAt: NOW,
        occurredOn: occurredOn as LocalDate,
        sourceKey: `fixture:${telegramId}:${n}`,
        createdAt: NOW,
        categoryId: categoryOf(preset),
      });
    return { user, ledgerId, categoryOf, add };
  }

  const owner = await join(ALLOWED_ID);
  // Cafe: June 100.00, August 200.00, 15 October 300.00, 10 November 50.00, and «450 кофе» sent
  // at 23:30 UTC on 31 October, which is 00:30 on 1 November in Belgrade. Groceries in November
  // stays out of the cafe's points.
  owner.add('2026-06-10', 10000, 'cafe');
  owner.add('2026-08-20', 20000, 'cafe');
  owner.add('2026-10-15', 30000, 'cafe');
  owner.add('2026-11-10', 5000, 'cafe');
  owner.add('2026-11-11', 99900, 'groceries');
  await say('450 кофе', ALLOWED_ID, new Date('2026-10-31T23:30:00Z'));
  calls.length = 0;
  return { bot, db, keys, deps, calls, say, ask, answers, join, owner };
}

const unavailable = JSON.stringify([1, messages.widgetUnavailable]);

describe('widget queries (ADR-0053)', () => {
  it("answers the owner's month query with the category's last six months in their timezone", async () => {
    const { ask, answers, owner } = await queryBot();
    const cafe = owner.categoryOf('cafe');

    await ask(`d:2026-11:${owner.ledgerId}:${cafe}`);

    expect(answers()).toEqual([
      {
        widget_query_id: 'wq-1',
        data: JSON.stringify([
          1,
          'Кафе и рестораны · последние 6 месяцев',
          [
            ['Июнь', 10000, '100.00 RSD'],
            ['Июль', 0, '0.00 RSD'],
            ['Август', 20000, '200.00 RSD'],
            ['Сентябрь', 0, '0.00 RSD'],
            ['Октябрь', 30000, '300.00 RSD'],
            ['Ноябрь', 50000, '500.00 RSD'],
          ],
          '‹ Все категории',
        ]),
      },
    ]);
  });

  it('answers a week query with six weekly points ending with the week of 9 November', async () => {
    const { ask, answers, owner } = await queryBot();

    await ask(`d:2026-11-09:${owner.ledgerId}:${owner.categoryOf('cafe')}`);

    expect(answers()).toEqual([
      {
        widget_query_id: 'wq-1',
        data: JSON.stringify([
          1,
          'Кафе и рестораны · последние 6 недель',
          [
            ['5–11 окт', 0, '0.00 RSD'],
            ['12–18 окт', 30000, '300.00 RSD'],
            ['19–25 окт', 0, '0.00 RSD'],
            ['26 окт – 1 ноя', 45000, '450.00 RSD'],
            ['2–8 ноя', 0, '0.00 RSD'],
            ['9–15 ноя', 5000, '50.00 RSD'],
          ],
          '‹ Все категории',
        ]),
      },
    ]);
  });

  it('answers widgetUnavailable for a category in a ledger the asker cannot read', async () => {
    const { ask, answers, join, owner } = await queryBot();
    const other = await join(SECOND_ALLOWED_ID);
    other.add('2026-11-05', 77700, 'cafe');

    // The other user's ledger, and the other user's category under the owner's own ledger.
    await ask(`d:2026-11:${other.ledgerId}:${other.categoryOf('cafe')}`);
    await ask(`d:2026-11:${owner.ledgerId}:${other.categoryOf('cafe')}`);

    expect(answers().map((answer) => (answer as { data: string }).data)).toEqual([
      unavailable,
      unavailable,
    ]);
  });

  it.each([
    ['d:'],
    ['d:x:y'],
    ['d:2026-11:00000000-0000-4000-8000-000000000001:' + '1'.repeat(17)],
    ['d:2026-13:00000000-0000-4000-8000-000000000001:1'],
    ['d:2026-11-10:00000000-0000-4000-8000-000000000001:1'],
  ])('answers widgetUnavailable to malformed data %j, with no throw', async (data) => {
    const { ask, answers } = await queryBot();

    await ask(data);

    expect(answers()).toEqual([{ widget_query_id: 'wq-1', data: unavailable }]);
  });

  it('answers widgetUnavailable to 65 bytes of data, with no throw', async () => {
    const { ask, answers, owner } = await queryBot();
    const data = `d:2026-11:${owner.ledgerId}:${'9'.repeat(16)}`.padEnd(65, '0');
    expect(utf8Bytes(data)).toBe(65);

    await ask(data);

    expect(answers()).toEqual([{ widget_query_id: 'wq-1', data: unavailable }]);
  });

  it('answers widgetLocked on a locked sealed ledger', async () => {
    const { ask, answers, db, keys, owner } = await queryBot();
    const ledger = await sealPersonalLedger(
      { db, logger: createLogger('silent'), keys },
      owner.user,
      NOW,
    );
    keys.lock(ledger.id);

    await ask(`d:2026-11:${owner.ledgerId}:${owner.categoryOf('cafe')}`);

    expect(answers()).toEqual([
      { widget_query_id: 'wq-1', data: JSON.stringify([1, messages.widgetLocked]) },
    ]);
    expect(messages.widgetLocked).toBe('Учёт закрыт. Откройте его в боте, чтобы смотреть детали.');
  });

  it('answers the admitted owner with data, and a blocked or never-admitted sender with widgetUnavailable', async () => {
    const { ask, answers, deps, join, owner } = await queryBot();
    const blocked = await join(SECOND_ALLOWED_ID);
    blocked.add('2026-11-05', 77700, 'cafe');
    setBlocked(deps, { telegramId: SECOND_ALLOWED_ID, blocked: true, now: NOW });
    const query = `d:2026-11:${owner.ledgerId}:${owner.categoryOf('cafe')}`;

    await ask(query);
    await ask(`d:2026-11:${blocked.ledgerId}:${blocked.categoryOf('cafe')}`, SECOND_ALLOWED_ID);
    await ask(query, STRANGER_ID);

    const data = answers().map((answer) => (answer as { data: string }).data);
    expect((JSON.parse(data[0] ?? '') as unknown[]).slice(0, 2)).toEqual([
      1,
      'Кафе и рестораны · последние 6 месяцев',
    ]);
    expect(data.slice(1)).toEqual([unavailable, unavailable]);
  });

  it('fits six periods of the longest category name the categories module allows in 1024 bytes', async () => {
    const { ask, answers, db, owner } = await queryBot();
    const cafe = owner.categoryOf('cafe');
    // Four bytes a character, the most UTF-8 spends on one.
    const longest = '😀'.repeat(MAX_CATEGORY_NAME);
    renameCategory(db, cafe, longest, categoryNameKey(longest));
    for (const month of ['06', '07', '08', '09', '10', '11']) {
      owner.add(`2026-${month}-02`, 99_999_999_999, 'cafe');
    }

    await ask(`d:2026-11:${owner.ledgerId}:${cafe}`);

    const data = (answers()[0] as { data: string }).data;
    expect(utf8Bytes(data)).toBeLessThanOrEqual(1024);
    const [, title, points] = JSON.parse(data) as [1, string, unknown[]];
    expect(title).toBe(`${longest} · последние 6 месяцев`);
    expect(points).toHaveLength(6);
  });

  it('answers the same query twice with identical data and writes nothing', async () => {
    const { ask, answers, db, owner } = await queryBot();
    const changes = () => db.prepare('SELECT total_changes()').pluck().get() as number;
    const query = `d:2026-11:${owner.ledgerId}:${owner.categoryOf('cafe')}`;
    const before = changes();

    await ask(query);
    await ask(query);

    const [first, second] = answers() as { data: string }[];
    expect(first?.data).toBe(second?.data);
    expect(JSON.parse(first?.data ?? '')).toHaveLength(4);
    expect(changes()).toBe(before);
  });
});
