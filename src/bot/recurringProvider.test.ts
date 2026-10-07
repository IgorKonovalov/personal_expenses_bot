import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findUserByIdentity, markUnreachable } from '../db/users.js';
import { createLogger } from '../logger.js';
import { createReminder } from '../services/recurring.js';
import { register } from '../scheduler/types.js';
import { runTick } from '../scheduler/worker.js';
import type { HandlerDeps } from './bot.js';
import { messages } from './messages.js';
import { htmlParseMode } from './render/html.js';
import { recurringProvider } from './recurringProvider.js';
import { scheduledSender } from './scheduledSender.js';
import { ALLOWED_ID, callbackUpdate, createTestBot, textUpdate } from './testHarness.js';

const EXPENSE_ID = '00000000-0000-4000-8000-000000000003';

// `45000 аренда` sent on 1 October, repeated «Каждый месяц, 1-го» on 2 October.
async function rentRule() {
  const clock = new Date('2026-10-02T10:00:00Z');
  const harness = createTestBot({ now: clock });
  const { bot } = harness;
  await bot.handleUpdate(
    textUpdate({ updateId: 1, text: '45000 аренда', date: new Date('2026-10-01T10:00:00Z') }),
  );
  await bot.handleUpdate(callbackUpdate({ updateId: 2, data: `rec:new:${EXPENSE_ID}` }));
  await bot.handleUpdate(callbackUpdate({ updateId: 3, data: `rec:s:${EXPENSE_ID}:m` }));
  const deps: HandlerDeps = {
    db: harness.db,
    logger: createLogger('silent'),
    newId: randomUUID,
    now: () => clock,
    defaultTimezone: 'Europe/Belgrade',
    defaultCurrency: 'RSD',
    keys: harness.keys,
  };
  const sender = scheduledSender({
    api: bot.api,
    db: harness.db,
    logger: deps.logger,
    now: () => clock,
    sleep: () => Promise.resolve(),
  });
  const providers = [register(recurringProvider(deps, sender))];
  const tick = (at: string) => runTick({ logger: deps.logger, providers }, new Date(at));
  return { ...harness, clock, tick };
}

function occurrenceId(db: ReturnType<typeof createTestBot>['db']): string {
  return db
    .prepare("SELECT id FROM expenses WHERE source_key LIKE 'rec:%'")
    .pluck()
    .get() as string;
}

describe('the recurring provider', () => {
  it('posts the recorded rent, marked recurring, with [Удалить], to the author', async () => {
    const { calls, db, tick } = await rentRule();
    calls.length = 0;

    await tick('2026-11-01T08:00:00Z');

    const id = occurrenceId(db);
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: ALLOWED_ID,
          text: 'Записано в «Личные расходы»: <b>45 000.00 RSD</b> — аренда (регулярная) · Жильё и коммуналка',
          reply_markup: {
            inline_keyboard: [[{ text: messages.undoButton, callback_data: `exp:undo:${id}` }]],
          },
          ...htmlParseMode,
        },
      },
    ]);
  });

  it('posts nothing on a second tick at the same time', async () => {
    const { calls, tick } = await rentRule();
    await tick('2026-11-01T08:00:00Z');
    calls.length = 0;

    await tick('2026-11-01T08:00:00Z');

    expect(calls).toEqual([]);
  });

  it('records the rent for an author who blocked the bot, and sends nothing', async () => {
    const { calls, db, tick } = await rentRule();
    markUnreachable(db, ALLOWED_ID, new Date('2026-10-15T10:00:00Z'));
    calls.length = 0;

    await tick('2026-11-01T08:00:00Z');

    expect(calls).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT amount_minor, occurred_on FROM expenses WHERE source_key LIKE 'rec:%' AND deleted_at IS NULL",
        )
        .all(),
    ).toEqual([{ amount_minor: 4500000, occurred_on: '2026-11-01' }]);
  });

  it('claims a due reminder for an author who blocked the bot without sending it, once', async () => {
    const harness = await rentRule();
    const { calls, db, tick } = harness;
    const user = findUserByIdentity(db, 'telegram', String(ALLOWED_ID));
    if (user === undefined) throw new Error('not provisioned');
    // Monthly on the 2nd, from 2 October: first due 2 November at 09:00 Belgrade.
    const rule = createReminder(
      {
        db,
        logger: createLogger('silent'),
        newId: randomUUID,
        defaultTimezone: 'Europe/Belgrade',
        keys: harness.keys,
      },
      { user, text: 'оплатить интернет', choice: 'm', now: harness.clock },
    );
    await tick('2026-11-01T08:00:00Z');
    markUnreachable(db, ALLOWED_ID, new Date('2026-11-01T12:00:00Z'));
    calls.length = 0;

    await tick('2026-11-02T08:00:00Z');
    await tick('2026-11-02T08:01:00Z');

    expect(calls).toEqual([]);
    expect(
      db
        .prepare('SELECT due_on, outcome FROM recurring_occurrences WHERE rule_id = ?')
        .all(rule.id),
    ).toEqual([{ due_on: '2026-11-02', outcome: 'reminded' }]);
    expect(
      db.prepare('SELECT next_due_on FROM recurring_rules WHERE id = ?').pluck().get(rule.id),
    ).toBe('2026-12-02');
  });

  it('[Удалить] soft-deletes the occurrence, and the rule keeps its next date', async () => {
    const { bot, db, tick } = await rentRule();
    await tick('2026-11-01T08:00:00Z');
    const id = occurrenceId(db);

    await bot.handleUpdate(callbackUpdate({ updateId: 10, data: `exp:undo:${id}` }));

    expect(
      db.prepare('SELECT deleted_at IS NOT NULL FROM expenses WHERE id = ?').pluck().get(id),
    ).toBe(1);
    expect(db.prepare('SELECT next_due_on FROM recurring_rules').pluck().get()).toBe('2026-12-01');
  });
});
