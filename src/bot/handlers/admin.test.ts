import { describe, expect, it } from 'vitest';
import type { LocalDate } from '../../domain/time.js';
import { messages } from '../messages.js';
import {
  ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  groupTextUpdate,
  myChatMemberUpdate,
  textUpdate,
} from '../testHarness.js';

const MEMBER = 222;
const OTHER = 333;

type TestBot = ReturnType<typeof createTestBot>;

let updateId = 0;

async function say(bot: TestBot['bot'], fromId: number, text: string, messageId = 1) {
  await bot.handleUpdate(textUpdate({ updateId: ++updateId, fromId, text, messageId }));
}

// The admin makes a code and each id redeems it.
async function admit({ bot, db }: TestBot, ...ids: number[]): Promise<string> {
  await say(bot, ALLOWED_ID, '/invite');
  const code = db
    .prepare('SELECT code FROM invite_codes ORDER BY created_at DESC, rowid DESC')
    .pluck()
    .get() as string;
  for (const id of ids) await say(bot, id, `/start ${code}`);
  return code;
}

function expenseCount(db: TestBot['db']): unknown {
  return db.prepare('SELECT COUNT(*) FROM expenses').pluck().get();
}

describe('/invites', () => {
  it('lists live codes with [Отключить], which makes the next redemption fail', async () => {
    const t = createTestBot();
    const code = await admit(t, MEMBER);
    t.calls.length = 0;

    await say(t.bot, ALLOWED_ID, '/invites');
    expect(t.calls).toMatchObject([
      {
        payload: {
          // 2026-09-29T22:10Z + 14 days, in Belgrade (UTC+2): 14 October.
          text: messages.inviteList([
            { code, used: 1, maxUses: 10, expiresOn: '2026-10-14' as LocalDate },
          ]),
          reply_markup: {
            inline_keyboard: [
              [{ text: messages.inviteRevokeButton(code), callback_data: `inv:off:${code}` }],
            ],
          },
        },
      },
    ]);

    t.calls.length = 0;
    await t.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data: `inv:off:${code}` }));
    await t.bot.handleUpdate(callbackUpdate({ updateId: ++updateId, data: `inv:off:${code}` }));
    expect(t.calls.filter((c) => c.method === 'answerCallbackQuery')).toMatchObject([
      { payload: { text: messages.inviteRevokedToast } },
      { payload: { text: messages.inviteAlreadyRevoked } },
    ]);
    expect(t.calls.filter((c) => c.method === 'editMessageText')).toMatchObject([
      { payload: { text: messages.inviteList([]) } },
    ]);

    t.calls.length = 0;
    await say(t.bot, OTHER, `/start ${code}`);
    expect(t.calls).toMatchObject([{ payload: { chat_id: OTHER, text: messages.inviteInvalid } }]);
  });
});

describe('/block and /unblock', () => {
  it('stops a blocked user recording in private and in a bound group, until /unblock', async () => {
    const t = createTestBot();
    await t.bot.handleUpdate(
      myChatMemberUpdate({
        updateId: ++updateId,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    await admit(t, MEMBER);
    const group = (messageId: number) =>
      t.bot.handleUpdate(
        groupTextUpdate({ updateId: ++updateId, fromId: MEMBER, text: '450 кофе', messageId }),
      );

    t.calls.length = 0;
    await say(t.bot, ALLOWED_ID, `/block ${MEMBER}`);
    expect(t.calls).toMatchObject([{ payload: { text: messages.blocked(MEMBER) } }]);

    t.calls.length = 0;
    await say(t.bot, MEMBER, '450 кофе', 10);
    await group(11);
    expect(expenseCount(t.db)).toBe(0);
    expect(t.calls).toEqual([]);

    await say(t.bot, ALLOWED_ID, `/unblock ${MEMBER}`);
    await say(t.bot, MEMBER, '450 кофе', 12);
    await group(13);
    expect(expenseCount(t.db)).toBe(2);
  });

  it('answers a repeat, an unknown id, the admin and a bad argument', async () => {
    const t = createTestBot();
    await admit(t, MEMBER);
    t.calls.length = 0;

    await say(t.bot, ALLOWED_ID, `/block ${MEMBER}`);
    await say(t.bot, ALLOWED_ID, `/block ${MEMBER}`);
    await say(t.bot, ALLOWED_ID, `/block ${OTHER}`);
    await say(t.bot, ALLOWED_ID, `/block ${ALLOWED_ID}`);
    await say(t.bot, ALLOWED_ID, '/block abc');
    await say(t.bot, ALLOWED_ID, `/unblock ${MEMBER}`);
    await say(t.bot, ALLOWED_ID, `/unblock ${MEMBER}`);

    expect(t.calls.map((c) => (c.payload as { text: string }).text)).toEqual([
      messages.blocked(MEMBER),
      messages.alreadyBlocked(MEMBER),
      messages.blockUserNotFound(OTHER),
      messages.blockAdmin,
      messages.blockUsage,
      messages.unblocked(MEMBER),
      messages.notBlocked(MEMBER),
    ]);
  });
});

describe('/stats', () => {
  it('counts 3 admitted, 1 active and 2 expenses over the last 7 days', async () => {
    const t = createTestBot();
    await admit(t, MEMBER, OTHER);
    // The boot admission of the admin's row (its /invite provisioned it).
    t.db
      .prepare(
        `UPDATE users SET admitted_at = '2026-09-29T22:10:00.000Z'
          WHERE id = (SELECT user_id FROM auth_identities WHERE external_id = ?)`,
      )
      .run(String(ALLOWED_ID));
    await say(t.bot, MEMBER, '450 кофе', 20);
    await say(t.bot, MEMBER, '120 хлеб', 21);
    await say(t.bot, OTHER, '300 такси', 22);
    // OTHER's expense was created 8 days before the clock.
    t.db
      .prepare(
        `UPDATE expenses SET created_at = '2026-09-21T22:10:00.000Z'
          WHERE created_by = (SELECT user_id FROM auth_identities WHERE external_id = ?)`,
      )
      .run(String(OTHER));
    t.calls.length = 0;

    await say(t.bot, ALLOWED_ID, '/stats');

    expect(t.calls).toMatchObject([
      {
        payload: {
          text: messages.stats({ admitted: 3, active: 1, expenses: 2, liveCodes: 1 }),
        },
      },
    ]);
  });

  it.each(['/stats', '/invites', '/block 1001', '/unblock 1001', '/invite'])(
    'answers %s from a non-admin with the /help reply',
    async (command) => {
      const t = createTestBot();
      await admit(t, MEMBER);
      t.calls.length = 0;

      await say(t.bot, MEMBER, command);

      expect(t.calls).toMatchObject([{ payload: { chat_id: MEMBER, text: messages.help } }]);
    },
  );
});
