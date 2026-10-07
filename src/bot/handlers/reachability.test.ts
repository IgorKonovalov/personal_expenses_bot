import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { findUserByIdentity, listPushRecipients, setUserBlocked } from '../../db/users.js';
import { ALLOWED_ID, SECOND_ALLOWED_ID, createTestBot, textUpdate } from '../testHarness.js';

const NOW = new Date('2026-09-29T22:10:00Z');

// The user blocking (`kicked`) or unblocking (`member`) the bot in their private chat.
function privateMemberUpdate(updateId: number, fromId: number, status: 'kicked' | 'member') {
  const bot = { id: 42, is_bot: true, first_name: 'Test Bot' };
  const member = (s: string) =>
    s === 'kicked' ? { status: s, user: bot, until_date: 0 } : { status: s, user: bot };
  return {
    update_id: updateId,
    my_chat_member: {
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      date: 1_790_000_000,
      old_chat_member: member(status === 'kicked' ? 'member' : 'kicked'),
      new_chat_member: member(status),
    },
  } as Update;
}

async function provisioned(fromId = ALLOWED_ID) {
  const harness = createTestBot({ now: NOW });
  await harness.bot.handleUpdate(textUpdate({ updateId: 1, fromId, text: '450 кофе' }));
  const user = findUserByIdentity(harness.db, 'telegram', String(fromId));
  if (user === undefined) throw new Error('not provisioned');
  const column = (name: 'unreachable_at' | 'blocked_at' | 'monthly_push') =>
    harness.db.prepare(`SELECT ${name} FROM users WHERE id = ?`).pluck().get(user.id);
  return { ...harness, user, column };
}

describe('reachability', () => {
  it('sets unreachable_at on a private kicked update, and clears it on member', async () => {
    const { bot, calls, column } = await provisioned();
    calls.length = 0;

    await bot.handleUpdate(privateMemberUpdate(2, ALLOWED_ID, 'kicked'));
    expect(column('unreachable_at')).toBe(NOW.toISOString());
    expect(calls).toEqual([]);

    await bot.handleUpdate(privateMemberUpdate(3, ALLOWED_ID, 'member'));
    expect(column('unreachable_at')).toBeNull();
  });

  it('drops a kicked user from the push recipients until they send any private message', async () => {
    const { bot, db, user, column } = await provisioned();
    expect(column('monthly_push')).toBe(1);

    await bot.handleUpdate(privateMemberUpdate(2, ALLOWED_ID, 'kicked'));
    expect(listPushRecipients(db).map((r) => r.user.id)).toEqual([]);

    await bot.handleUpdate(textUpdate({ updateId: 3, text: '/help' }));
    expect(listPushRecipients(db).map((r) => [r.user.id, r.monthly])).toEqual([[user.id, true]]);
    expect(column('monthly_push')).toBe(1);
  });

  it('keeps an admin-blocked user blocked after a message, while clearing unreachable_at', async () => {
    const { bot, db, user, calls, column } = await provisioned(SECOND_ALLOWED_ID);
    const blockedAt = new Date('2026-09-28T10:00:00Z');
    setUserBlocked(db, user.id, blockedAt);
    await bot.handleUpdate(privateMemberUpdate(2, SECOND_ALLOWED_ID, 'kicked'));
    expect(column('unreachable_at')).toBe(NOW.toISOString());
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 3, fromId: SECOND_ALLOWED_ID, text: '/help' }));

    expect(column('unreachable_at')).toBeNull();
    expect(column('blocked_at')).toBe(blockedAt.toISOString());
    expect(calls).toEqual([]);
  });
});
