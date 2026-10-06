import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setBudgetLimit, setBudgetStartDay } from '../db/budgets.js';
import type { CategoryId } from '../db/categories.js';
import { setFxDay, storeFxList } from '../db/fxRates.js';
import { insertExpenseOrGetExisting, type ExpenseId } from '../db/expenses.js';
import type { LedgerId } from '../db/ledgers.js';
import { setPushOn, type UserId } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { LocalDate } from '../domain/time.js';
import { createLogger } from '../logger.js';
import { register } from '../scheduler/types.js';
import { runTick } from '../scheduler/worker.js';
import type { HandlerDeps } from './bot.js';
import { messages } from './messages.js';
import { htmlParseMode } from './render/html.js';
import { summaryProvider } from './summaryProvider.js';
import { ALLOWED_ID, callbackUpdate, createTestBot, textUpdate } from './testHarness.js';

// A Europe/Belgrade user (the harness default) whose personal ledger exists from 20 August.
async function pushBot() {
  const clock = new Date('2026-08-20T10:00:00Z');
  const harness = createTestBot({ now: clock });
  await harness.bot.handleUpdate(textUpdate({ updateId: 1, text: '/today' }));
  const { db } = harness;
  const ledgerId = db
    .prepare("SELECT id FROM ledgers WHERE kind = 'personal'")
    .pluck()
    .get() as LedgerId;
  const userId = db.prepare('SELECT id FROM users').pluck().get() as UserId;
  const deps: HandlerDeps = {
    db,
    logger: createLogger('silent'),
    newId: randomUUID,
    now: () => clock,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    keys: harness.keys,
  };
  const providers = [register(summaryProvider(deps, harness.bot.api))];
  const tick = (at: string) => runTick({ logger: deps.logger, providers }, new Date(at));
  let n = 0;
  // A plaintext expense in a preset's category, or in none.
  const add = (
    occurredOn: string,
    amountMinor: number,
    preset: string | null,
    currency: CurrencyCode = 'RSD',
    description = 'синтетика',
  ) => {
    const categoryId =
      preset === null
        ? undefined
        : (db
            .prepare('SELECT id FROM categories WHERE ledger_id = ? AND preset_key = ?')
            .pluck()
            .get(ledgerId, preset) as CategoryId);
    insertExpenseOrGetExisting(db, {
      id: `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as ExpenseId,
      ledgerId,
      createdBy: userId,
      amountMinor,
      currency,
      description,
      occurredAt: new Date(`${occurredOn}T10:00:00Z`),
      occurredOn: occurredOn as LocalDate,
      sourceKey: `test:${String(n)}`,
      createdAt: clock,
      ...(categoryId === undefined ? {} : { categoryId }),
    });
  };
  harness.calls.length = 0;
  return { ...harness, ledgerId, tick, add };
}

const sent = (calls: { method: string; payload: unknown }[]) =>
  calls.filter((c) => c.method === 'sendMessage').map((c) => (c.payload as { text: string }).text);

// The one push's text, split into its blank-line-separated blocks.
const blocks = (calls: { method: string; payload: unknown }[]) => {
  const texts = sent(calls);
  expect(texts).toHaveLength(1);
  return texts[0]?.split('\n\n') ?? [];
};

const offKeyboard = {
  inline_keyboard: [[{ text: messages.pushOffButton, callback_data: 'sum:off:m' }]],
};

describe('the summary provider: the monthly push', () => {
  it('sends «Итоги сентября» at 09:00 CEST on 1 October, not a minute before, and once', async () => {
    const { calls, tick, add } = await pushBot();
    add('2026-08-10', 930000, 'cafe');
    add('2026-09-10', 1240000, 'cafe');

    await tick('2026-10-01T06:59:00Z');
    expect(calls).toEqual([]);

    await tick('2026-10-01T07:00:00Z');
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: [
            '<b>Итоги сентября</b>',
            '',
            '<b>12 400.00 RSD</b> (+3 100.00, +33%)',
            'Кафе и рестораны: 12 400.00 RSD (+3 100.00, +33%)',
            '',
            '<b>Самые крупные траты</b>',
            '10.09 · 12 400.00 RSD · синтетика',
            '',
            'Бот бесплатный. Поддержать: /donate',
          ].join('\n'),
          reply_markup: offKeyboard,
          ...htmlParseMode,
        },
      },
    ]);

    calls.length = 0;
    await tick('2026-10-01T07:01:00Z');
    await tick('2026-10-01T21:00:00Z');
    expect(calls).toEqual([]);
  });

  it('shows a decrease as «−3 100.00» and «−25%», and a category absent before as «новое»', async () => {
    const { calls, tick, add } = await pushBot();
    add('2026-08-10', 1240000, 'cafe');
    add('2026-09-10', 930000, 'cafe');
    add('2026-09-11', 50000, 'transport');

    await tick('2026-10-01T07:00:00Z');

    expect(blocks(calls)[1]).toBe(
      [
        '<b>9 800.00 RSD</b> (−2 600.00, −21%)',
        'Кафе и рестораны: 9 300.00 RSD (−3 100.00, −25%)',
        'Транспорт: 500.00 RSD (новое)',
      ].join('\n'),
    );
  });

  it('sends nothing on 9 October to a user with no row: the 1 October push is over 7 days old', async () => {
    const { calls, db, tick, add } = await pushBot();
    add('2026-09-10', 1240000, 'cafe');

    await tick('2026-10-09T07:00:00Z');

    expect(calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM summary_pushes').pluck().get()).toBe(0);
  });

  it('still sends on 8 October at 09:00, exactly 7 days after the due instant', async () => {
    const { calls, tick, add } = await pushBot();
    add('2026-09-10', 1240000, 'cafe');

    await tick('2026-10-08T07:00:00Z');

    expect(sent(calls)).toHaveLength(1);
  });

  it('sends nothing for a September with no expenses and leaves one `empty` row', async () => {
    const { calls, db, ledgerId, tick, add } = await pushBot();
    add('2026-08-10', 930000, 'cafe');

    await tick('2026-10-01T07:00:00Z');
    await tick('2026-10-01T08:00:00Z');

    expect(calls).toEqual([]);
    expect(
      db.prepare('SELECT ledger_id, kind, period_key, outcome FROM summary_pushes').all(),
    ).toEqual([{ ledger_id: ledgerId, kind: 'period', period_key: '2026-09', outcome: 'empty' }]);
  });

  it('[Отключить] sets monthly_push to 0 and takes the keyboard away; October then sends nothing', async () => {
    const { bot, calls, db, tick, add } = await pushBot();
    add('2026-09-10', 1240000, 'cafe');
    add('2026-10-10', 1240000, 'cafe');
    await tick('2026-10-01T07:00:00Z');
    calls.length = 0;

    await bot.handleUpdate(callbackUpdate({ updateId: 10, data: 'sum:off:m' }));

    expect(db.prepare('SELECT monthly_push FROM users').pluck().get()).toBe(0);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: { callback_query_id: 'cb-10', text: messages.pushOff('monthly') },
      },
      {
        method: 'editMessageReplyMarkup',
        payload: { chat_id: ALLOWED_ID, message_id: 2, reply_markup: { inline_keyboard: [] } },
      },
    ]);

    calls.length = 0;
    // 1 November, 09:00 CET.
    await tick('2026-11-01T08:00:00Z');
    expect(calls).toEqual([]);
  });

  it('fires at 09:00 CET once the clocks went back: 1 November is 08:00 UTC', async () => {
    const { calls, tick, add } = await pushBot();
    add('2026-10-10', 1240000, 'cafe');

    await tick('2026-11-01T07:59:00Z');
    expect(calls).toEqual([]);
    await tick('2026-11-01T08:00:00Z');
    expect(blocks(calls).slice(0, 2)).toEqual([
      '<b>Итоги октября</b>',
      ['<b>12 400.00 RSD</b> (новое)', 'Кафе и рестораны: 12 400.00 RSD (новое)'].join('\n'),
    ]);
  });

  it('collapses the categories past the top 10 into one line with their sum', async () => {
    const { calls, tick, add } = await pushBot();
    const presets = [
      'groceries',
      'cafe',
      'transport',
      'housing',
      'health',
      'clothes',
      'fun',
      'telecom',
      'gifts',
      'other',
    ];
    // 2 000.00 down to 1 100.00 RSD, «Другое» the 10th; the uncategorized 70.00 is the 11th.
    presets.forEach((preset, i) => {
      add('2026-09-10', 200000 - i * 10000, preset);
    });
    add('2026-09-11', 5000, null);
    add('2026-09-12', 2000, null);

    await tick('2026-10-01T07:00:00Z');

    const lines = blocks(calls)[1]?.split('\n') ?? [];
    expect(lines).toHaveLength(1 + 10 + 1);
    expect(lines.slice(-2)).toEqual([
      'Другое: 1 100.00 RSD (новое)',
      'и ещё 1 категория: 70.00 RSD',
    ]);
  });
});

describe('the summary provider: the weekly push', () => {
  const weekly = (db: Parameters<typeof setPushOn>[0]) => {
    const userId = db.prepare('SELECT id FROM users').pluck().get() as UserId;
    setPushOn(db, userId, 'weekly', true);
  };

  it('sends 28 September – 4 October on Monday 5 October at 09:00 CEST, once, with [Отключить] sum:off:w', async () => {
    const { calls, db, tick, add } = await pushBot();
    weekly(db);
    // The monthly push would send September, still inside its 7 days.
    db.prepare('UPDATE users SET monthly_push = 0').run();
    add('2026-09-21', 930000, 'cafe');
    add('2026-10-02', 1240000, 'cafe');
    // In neither week.
    add('2026-10-05', 5000, 'transport');

    await tick('2026-10-05T06:59:00Z');
    expect(calls).toEqual([]);
    await tick('2026-10-05T07:00:00Z');

    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: [
            '<b>Итоги недели 28 сентября – 4 октября</b>',
            '',
            '<b>12 400.00 RSD</b> (+3 100.00, +33%)',
            'Кафе и рестораны: 12 400.00 RSD (+3 100.00, +33%)',
          ].join('\n'),
          reply_markup: {
            inline_keyboard: [[{ text: messages.pushOffButton, callback_data: 'sum:off:w' }]],
          },
          ...htmlParseMode,
        },
      },
    ]);
    expect(
      db.prepare("SELECT period_key FROM summary_pushes WHERE kind = 'week'").pluck().all(),
    ).toEqual(['2026-09-28']);

    calls.length = 0;
    await tick('2026-10-05T07:01:00Z');
    await tick('2026-10-06T07:00:00Z');
    expect(calls).toEqual([]);
  });

  it('sends nothing with the weekly push off, the default', async () => {
    const { calls, db, tick, add } = await pushBot();
    add('2026-10-02', 1240000, 'cafe');

    await tick('2026-10-05T07:00:00Z');

    expect(calls).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) FROM summary_pushes WHERE kind = 'week'").pluck().get(),
    ).toBe(0);
  });

  it('[Отключить] on the weekly push turns it off, and the next Monday sends nothing', async () => {
    const { bot, calls, db, tick, add } = await pushBot();
    weekly(db);
    add('2026-10-02', 1240000, 'cafe');
    add('2026-10-07', 1240000, 'cafe');
    await tick('2026-10-05T07:00:00Z');
    calls.length = 0;

    await bot.handleUpdate(callbackUpdate({ updateId: 10, data: 'sum:off:w' }));

    expect(db.prepare('SELECT weekly_push, monthly_push FROM users').get()).toEqual({
      weekly_push: 0,
      monthly_push: 1,
    });
    expect(calls[0]).toEqual({
      method: 'answerCallbackQuery',
      payload: { callback_query_id: 'cb-10', text: messages.pushOff('weekly') },
    });

    calls.length = 0;
    await tick('2026-10-12T07:00:00Z');
    expect(calls).toEqual([]);
  });

  it('sends the monthly and the weekly push as separate messages, each once', async () => {
    const { calls, db, tick, add } = await pushBot();
    weekly(db);
    add('2026-09-10', 1240000, 'cafe');
    add('2026-10-02', 50000, 'transport');

    await tick('2026-10-05T07:00:00Z');
    await tick('2026-10-05T07:01:00Z');

    const titles = sent(calls).map((text) => text.split('\n')[0]);
    expect(titles).toEqual([
      '<b>Итоги сентября</b>',
      '<b>Итоги недели 28 сентября – 4 октября</b>',
    ]);
  });
});

describe('the summary provider: budget periods, the budget block and the top 3', () => {
  const NOW = new Date('2026-09-01T10:00:00Z');

  it('with a start day of 15, sends «Итоги периода 15.09–14.10» on 15 October against 15.08–14.09, and nothing on 1 October', async () => {
    const { calls, db, ledgerId, tick, add } = await pushBot();
    setBudgetStartDay(db, ledgerId, { startDay: 15, currency: 'RSD' }, NOW);
    // 14.08 is in the period before 15.08–14.09; 15.08 and 14.09 bound it.
    add('2026-08-14', 500000, 'cafe');
    add('2026-08-15', 400000, 'cafe');
    add('2026-09-14', 530000, 'cafe');
    add('2026-09-15', 1240000, 'cafe');
    add('2026-10-14', 10000, 'transport');
    add('2026-10-15', 777700, 'transport');

    await tick('2026-10-01T07:00:00Z');
    expect(calls).toEqual([]);
    await tick('2026-10-15T06:59:00Z');
    expect(calls).toEqual([]);

    await tick('2026-10-15T07:00:00Z');

    expect(blocks(calls).slice(0, 2)).toEqual([
      '<b>Итоги периода 15.09–14.10</b>',
      [
        // 1 250 000 against 930 000: +320 000, 34.4%.
        '<b>12 500.00 RSD</b> (+3 200.00, +34%)',
        'Кафе и рестораны: 12 400.00 RSD (+3 100.00, +33%)',
        'Транспорт: 100.00 RSD (новое)',
      ].join('\n'),
    ]);
    expect(db.prepare('SELECT period_key FROM summary_pushes').pluck().all()).toEqual([
      '2026-09-15',
    ]);
  });

  it('shows «перерасход 2 500.00 RSD» for 62 500.00 spent of a 60 000.00 limit', async () => {
    const { calls, db, ledgerId, tick, add } = await pushBot();
    setBudgetLimit(db, ledgerId, { limitMinor: 6000000, currency: 'RSD' }, NOW);
    add('2026-09-10', 6250000, 'cafe');

    await tick('2026-10-01T07:00:00Z');

    expect(blocks(calls)).toContain(
      '<b>Бюджет:</b> 62 500.00 из 60 000.00 RSD, перерасход 2 500.00 RSD',
    );
  });

  it('shows «осталось 10 000.00 RSD» for 50 000.00 spent of a 60 000.00 limit', async () => {
    const { calls, db, ledgerId, tick, add } = await pushBot();
    setBudgetLimit(db, ledgerId, { limitMinor: 6000000, currency: 'RSD' }, NOW);
    add('2026-09-10', 5000000, 'cafe');

    await tick('2026-10-01T07:00:00Z');

    expect(blocks(calls)).toContain(
      '<b>Бюджет:</b> 50 000.00 из 60 000.00 RSD, осталось 10 000.00 RSD',
    );
  });

  it('lists the three largest converted expenses, a foreign one by its converted amount', async () => {
    const { calls, db, tick, add } = await pushBot();
    // 117.5 RSD per EUR on 12 September.
    storeFxList(
      db,
      {
        listDate: '2026-09-12' as LocalDate,
        listNumber: 176,
        rates: [{ currency: 'EUR', unit: 1, middleE4: 1175000 }],
      },
      NOW,
    );
    setFxDay(db, '2026-09-12' as LocalDate, '2026-09-12' as LocalDate, NOW);
    add('2026-09-10', 100000, 'cafe', 'RSD', 'кафе');
    // 10.00 EUR = 1 175.00 RSD: the largest, though 1000 minor units.
    add('2026-09-12', 1000, 'cafe', 'EUR', 'музей <Прадо>');
    add('2026-09-13', 90000, 'transport', 'RSD', 'такси');
    add('2026-09-14', 50000, 'transport', 'RSD', 'автобус');

    await tick('2026-10-01T07:00:00Z');

    expect(blocks(calls)).toContain(
      [
        '<b>Самые крупные траты</b>',
        '12.09 · 10.00 EUR (≈ 1 175.00 RSD) · музей &lt;Прадо&gt;',
        '10.09 · 1 000.00 RSD · кафе',
        '13.09 · 900.00 RSD · такси',
      ].join('\n'),
    );
  });

  it('ends the monthly push with the /donate line', async () => {
    const { calls, tick, add } = await pushBot();
    add('2026-09-10', 100000, 'cafe');

    await tick('2026-10-01T07:00:00Z');

    expect(blocks(calls).at(-1)).toBe(messages.pushDonateLine);
  });
});
