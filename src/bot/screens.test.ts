import { describe, expect, it } from 'vitest';
import type { LedgerId } from '../db/ledgers.js';
import { findUserByIdentity } from '../db/users.js';
import { createLogger } from '../logger.js';
import type { HandlerDeps } from './bot.js';
import { setAnchor } from '../services/flowSessions.js';
import { backRow, cancelRow, requireScreen } from './screens.js';
import { createLedgerKeyring } from '../services/ledgerKeys.js';
import {
  ALLOWED_ID,
  SECOND_ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  textUpdate,
} from './testHarness.js';

describe('screen kit rows', () => {
  it('builds [« Назад] and [Отмена] as single-button rows', () => {
    expect(backRow('cat:open')).toEqual([{ text: '« Назад', callback_data: 'cat:open' }]);
    expect(cancelRow()).toEqual([{ text: 'Отмена', callback_data: 'flow:cancel' }]);
  });
});

describe('requireScreen', () => {
  // A zz: screen callback that records whether the prologue let it through.
  async function anchoredBot() {
    const harness = createTestBot();
    const handlerDeps = deps(harness);
    const passed: number[] = [];
    harness.bot.callbackQuery(/^zz:/, async (ctx) => {
      const tap = await requireScreen(ctx, handlerDeps);
      if (tap === undefined) return;
      passed.push(tap.anchor.messageId);
      await ctx.answerCallbackQuery();
    });
    await harness.bot.handleUpdate(textUpdate({ updateId: 1, text: '/start' }));
    const user = findUserByIdentity(harness.db, 'telegram', String(ALLOWED_ID));
    if (user === undefined) throw new Error('setup failed');
    setAnchor(harness, user, {
      chatId: ALLOWED_ID,
      messageId: 7,
      screen: { name: 'categories', ledgerId: user.activeLedgerId as LedgerId },
    });
    harness.calls.length = 0;
    return { ...harness, passed };
  }

  function deps(harness: ReturnType<typeof createTestBot>): HandlerDeps {
    let n = 0;
    return {
      db: harness.db,
      logger: createLogger('silent'),
      newId: () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`,
      now: () => new Date('2026-09-30T10:00:00Z'),
      defaultTimezone: 'Europe/Belgrade',
      defaultCurrency: 'RSD' as const,
      keys: createLedgerKeyring(),
    };
  }

  it('lets a tap on the current anchor through', async () => {
    const { bot, calls, passed } = await anchoredBot();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: 'zz:go', messageId: 7 }));

    expect(passed).toEqual([7]);
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', payload: { callback_query_id: 'cb-2' } },
    ]);
  });

  it.each([
    ['another message', ALLOWED_ID, 6],
    ['another user', SECOND_ALLOWED_ID, 7],
  ])('toasts staleScreen for a tap on %s', async (_case, fromId, messageId) => {
    const { bot, calls, passed } = await anchoredBot();

    await bot.handleUpdate(callbackUpdate({ updateId: 2, data: 'zz:go', fromId, messageId }));

    expect(passed).toEqual([]);
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        payload: {
          callback_query_id: 'cb-2',
          text: 'Этот экран устарел. Откройте его заново.',
        },
      },
    ]);
  });
});
