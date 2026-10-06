import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../messages.js';
import {
  ALLOWED_ID,
  GROUP_ID,
  STRANGER_ID,
  createTestBot,
  myChatMemberUpdate,
  textUpdate,
} from '../testHarness.js';
import { BoundedIdSet } from './access.js';

// A non-text message: past the gate it gets the help reply.
function locationUpdate(updateId: number, fromId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 1_790_000_000,
      chat: { id: fromId, type: 'private', first_name: 'Test' },
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      location: { latitude: 0, longitude: 0 },
    },
  };
}

const THIRD_ID = 3003;
const FOURTH_ID = 4004;

function admittedAt(db: ReturnType<typeof createTestBot>['db'], telegramId: number): unknown {
  return db
    .prepare(
      `SELECT u.admitted_at FROM auth_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'telegram' AND i.external_id = ?`,
    )
    .pluck()
    .get(String(telegramId));
}

describe('access', () => {
  it('answers a stranger once with the invitation reply, then nothing, and runs no handler', async () => {
    const { bot, calls, db } = createTestBot();
    const spy = vi.fn();
    bot.use(spy);

    await bot.handleUpdate(textUpdate({ updateId: 1, fromId: STRANGER_ID, text: '450 coffee' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, fromId: STRANGER_ID, text: '/start' }));
    await bot.handleUpdate(locationUpdate(3, STRANGER_ID));

    expect(spy).toHaveBeenCalledTimes(0);
    expect(calls).toMatchObject([
      { method: 'sendMessage', payload: { chat_id: STRANGER_ID, text: messages.invitationOnly } },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  it('lets the admin through to handlers', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(locationUpdate(1, ALLOWED_ID));

    expect(calls).toMatchObject([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.help } },
    ]);
  });

  it('answers the admin /start with the messages-module greeting', async () => {
    const { bot, calls } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/start' }));

    expect(calls).toMatchObject([
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID, text: messages.welcome } },
      { method: 'sendMessage', payload: { chat_id: ALLOWED_ID } },
    ]);
  });

  it('admits two ids with a code made by /invite 2 1 and refuses the third', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/invite 2 1' }));
    const code = db.prepare('SELECT code FROM invite_codes').pluck().get() as string;
    expect(code).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(calls).toMatchObject([
      {
        payload: {
          chat_id: ALLOWED_ID,
          text: messages.inviteCreated({
            link: `https://t.me/test_bot?start=${code}`,
            maxUses: 2,
            days: 1,
          }),
        },
      },
    ]);

    calls.length = 0;
    await bot.handleUpdate(
      textUpdate({ updateId: 2, fromId: STRANGER_ID, text: `/start ${code}` }),
    );
    await bot.handleUpdate(textUpdate({ updateId: 3, fromId: THIRD_ID, text: `/start ${code}` }));
    await bot.handleUpdate(textUpdate({ updateId: 4, fromId: FOURTH_ID, text: `/start ${code}` }));

    const { welcome } = messages;
    const check = messages.setupCheck({
      timezone: 'Europe/Belgrade',
      localTime: '00:10',
      currency: 'RSD',
    });
    expect(calls).toMatchObject([
      { payload: { chat_id: STRANGER_ID, text: welcome } },
      { payload: { chat_id: STRANGER_ID, text: check } },
      { payload: { chat_id: THIRD_ID, text: welcome } },
      { payload: { chat_id: THIRD_ID, text: check } },
      { payload: { chat_id: FOURTH_ID, text: messages.inviteInvalid } },
    ]);
    expect(admittedAt(db, STRANGER_ID)).toBe('2026-09-29T22:10:00.000Z');
    expect(admittedAt(db, THIRD_ID)).toBe('2026-09-29T22:10:00.000Z');
    expect(admittedAt(db, FOURTH_ID)).toBeUndefined();
    expect(
      db.prepare('SELECT COUNT(*) FROM invite_redemptions WHERE code = ?').pluck().get(code),
    ).toBe(2);

    // Admitted now: an expense records.
    calls.length = 0;
    await bot.handleUpdate(textUpdate({ updateId: 5, fromId: STRANGER_ID, text: '450 кофе' }));
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
  });

  it('leaves one redemption row for a redelivered /start <code>', async () => {
    const { bot, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/invite' }));
    const code = db.prepare('SELECT code FROM invite_codes').pluck().get() as string;

    const redeem = textUpdate({ updateId: 2, fromId: STRANGER_ID, text: `/start ${code}` });
    await bot.handleUpdate(redeem);
    await bot.handleUpdate(redeem);

    expect(db.prepare('SELECT COUNT(*) FROM invite_redemptions').pluck().get()).toBe(1);
  });

  it('answers an invalid code with the invalid-link reply and provisions nothing', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(
      textUpdate({ updateId: 1, fromId: STRANGER_ID, text: '/start AAAAAAAAAAA' }),
    );

    expect(calls).toMatchObject([{ payload: { text: messages.inviteInvalid } }]);
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0);
  });

  it('shows the usage for /invite arguments out of range', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/invite 0 7' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/invite 30 1001' }));
    await bot.handleUpdate(textUpdate({ updateId: 3, text: '/invite 30' }));

    expect(calls.map((c) => (c.payload as { text: string }).text)).toEqual([
      messages.inviteUsage,
      messages.inviteUsage,
      messages.inviteUsage,
    ]);
    expect(db.prepare('SELECT COUNT(*) FROM invite_codes').pluck().get()).toBe(0);
  });

  it('treats /invite from an admitted non-admin as an unknown command', async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, text: '/invite' }));
    const code = db.prepare('SELECT code FROM invite_codes').pluck().get() as string;
    await bot.handleUpdate(
      textUpdate({ updateId: 2, fromId: STRANGER_ID, text: `/start ${code}` }),
    );
    calls.length = 0;

    await bot.handleUpdate(textUpdate({ updateId: 3, fromId: STRANGER_ID, text: '/invite' }));

    expect(calls).toMatchObject([{ payload: { text: messages.help } }]);
    expect(db.prepare('SELECT COUNT(*) FROM invite_codes').pluck().get()).toBe(1);
  });

  it('leaves a group a stranger added it to, and binds one an invited user added it to', async () => {
    const { bot, calls, db } = createTestBot();

    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 1,
        fromId: STRANGER_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    expect(calls).toMatchObject([{ method: 'leaveChat', payload: { chat_id: GROUP_ID } }]);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_chats').pluck().get()).toBe(0);

    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/invite' }));
    const code = db.prepare('SELECT code FROM invite_codes').pluck().get() as string;
    await bot.handleUpdate(
      textUpdate({ updateId: 3, fromId: STRANGER_ID, text: `/start ${code}` }),
    );
    calls.length = 0;

    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: 4,
        fromId: STRANGER_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    expect(calls.map((c) => c.method)).not.toContain('leaveChat');
    expect(db.prepare('SELECT COUNT(*) FROM ledger_chats WHERE active = 1').pluck().get()).toBe(1);
  });
});

describe('BoundedIdSet', () => {
  it('reports a new id once and forgets the oldest past its capacity', () => {
    const set = new BoundedIdSet(2);

    expect(set.add(1)).toBe(true);
    expect(set.add(1)).toBe(false);
    expect(set.add(2)).toBe(true);
    expect(set.add(3)).toBe(true);
    // 1 was the oldest, so it was dropped.
    expect(set.add(1)).toBe(true);
    expect(set.add(3)).toBe(false);
  });
});
