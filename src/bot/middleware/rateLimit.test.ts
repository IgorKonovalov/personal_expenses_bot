import { describe, expect, it } from 'vitest';
import { messages } from '../messages.js';
import {
  SECOND_ALLOWED_ID,
  createTestBot,
  groupTextUpdate,
  logContent,
  successfulPaymentUpdate,
  textUpdate,
} from '../testHarness.js';
import { RateLimiter } from './rateLimit.js';

describe('RateLimiter', () => {
  it('passes 30 updates at t=0..29 s, drops the 31st at 30 s, and passes one at 60.001 s', () => {
    const limiter = new RateLimiter(30, 60_000);

    for (let s = 0; s < 30; s += 1) expect(limiter.allow(7, s * 1000), `t=${s}`).toBe(true);
    expect(limiter.allow(7, 30_000)).toBe(false);
    // The first update (t=0) has left the window.
    expect(limiter.allow(7, 60_001)).toBe(true);
    // Another id has its own window.
    expect(limiter.allow(8, 30_000)).toBe(true);
  });

  it("doesn't count dropped updates toward the window", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.allow(7, 0)).toBe(true);
    expect(limiter.allow(7, 1_000)).toBe(true);
    // Dropped all along the window: had they counted, 61 s would still be full.
    for (let t = 2_000; t <= 59_000; t += 1_000) expect(limiter.allow(7, t)).toBe(false);
    expect(limiter.allow(7, 60_001)).toBe(true);
    expect(limiter.allow(7, 61_001)).toBe(true);
  });

  it('logs a drop at most once per id per minute', () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.shouldLog(7, 0)).toBe(true);
    expect(limiter.shouldLog(7, 59_999)).toBe(false);
    expect(limiter.shouldLog(8, 1)).toBe(true);
    expect(limiter.shouldLog(7, 60_000)).toBe(true);
  });
});

describe('rateLimit middleware', () => {
  it('drops the 31st update in a minute silently, logging the update id only, once', async () => {
    const { bot, calls, logLines } = createTestBot({ logLevel: 'info' });

    for (let i = 1; i <= 32; i += 1) {
      await bot.handleUpdate(textUpdate({ updateId: i, fromId: SECOND_ALLOWED_ID, text: '/help' }));
    }

    expect(calls).toHaveLength(30);
    expect(calls.every((c) => (c.payload as { text: string }).text === messages.help)).toBe(true);
    const drops = logLines.map(logContent).filter((l) => l.includes('rate limit'));
    expect(drops).toEqual([
      JSON.stringify({ level: 30, updateId: 31, msg: 'update over the rate limit dropped' }),
    ]);
  });

  it('counts group updates too, and exempts the admin', async () => {
    const { bot, calls } = createTestBot();

    for (let i = 1; i <= 31; i += 1) {
      await bot.handleUpdate(textUpdate({ updateId: i, text: '/help' }));
    }
    expect(calls).toHaveLength(31);

    calls.length = 0;
    for (let i = 1; i <= 30; i += 1) {
      await bot.handleUpdate(
        groupTextUpdate({ updateId: 100 + i, fromId: SECOND_ALLOWED_ID, text: 'привет' }),
      );
    }
    await bot.handleUpdate(textUpdate({ updateId: 200, fromId: SECOND_ALLOWED_ID, text: '/help' }));
    expect(calls).toEqual([]);
  });

  it('records a successful_payment from a sender over the limit', async () => {
    const { bot, db } = createTestBot();

    for (let i = 1; i <= 30; i += 1) {
      await bot.handleUpdate(textUpdate({ updateId: i, fromId: SECOND_ALLOWED_ID, text: '/help' }));
    }
    await bot.handleUpdate(
      successfulPaymentUpdate({
        updateId: 31,
        stars: 50,
        chargeId: 'charge-1',
        fromId: SECOND_ALLOWED_ID,
      }),
    );

    expect(db.prepare('SELECT stars, telegram_payment_charge_id FROM donations').all()).toEqual([
      { stars: 50, telegram_payment_charge_id: 'charge-1' },
    ]);
  });
});
