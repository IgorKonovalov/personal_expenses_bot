import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { messages } from '../messages.js';
import { ALLOWED_ID, createTestBot, textUpdate } from '../testHarness.js';

const NOW = new Date('2026-10-01T12:05:00Z');

function sentTexts(calls: readonly { payload: unknown }[]): unknown[] {
  return calls.map((call) => (call.payload as { text?: unknown }).text);
}

function editedUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    edited_message: {
      message_id: 1,
      date: Math.floor(NOW.getTime() / 1000),
      edit_date: Math.floor(NOW.getTime() / 1000),
      chat: { id: ALLOWED_ID, type: 'private', first_name: 'Test' },
      from: { id: ALLOWED_ID, is_bot: false, first_name: 'Test' },
      text,
    },
  };
}

describe('the onboarding middleware', () => {
  it('adds nothing to the reply of an onboarded user', async () => {
    const { bot, calls } = createTestBot({ now: NOW });

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/help', date: NOW }));

    expect(sentTexts(calls)).toEqual([messages.help]);
  });

  it('onboards no one on an edited message', async () => {
    const { bot, calls, db } = createTestBot({ now: NOW, onboarding: true });

    await bot.handleUpdate(editedUpdate(1, '450 кофе'));

    expect(sentTexts(calls)).not.toContain(messages.welcome);
    expect(
      db.prepare('SELECT COUNT(*) FROM users WHERE onboarded_at IS NOT NULL').pluck().get(),
    ).toBe(0);
  });

  it('sends the pair after the reply of a never-onboarded user, once', async () => {
    const { bot, calls } = createTestBot({ now: NOW, onboarding: true });

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/help', date: NOW }));
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/help', date: NOW }));

    expect(sentTexts(calls)).toEqual([
      messages.help,
      messages.welcome,
      messages.setupCheck({ timezone: 'Europe/Belgrade', localTime: '14:05', currency: 'RSD' }),
      messages.help,
    ]);
  });
});
