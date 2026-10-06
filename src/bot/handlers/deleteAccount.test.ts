import { describe, expect, it } from 'vitest';
import { buildRsUrl } from '../../domain/receipts/testing/buildRsVl.js';
import { messages } from '../messages.js';
import {
  ALLOWED_ID,
  callbackUpdate,
  createTestBot,
  groupTextUpdate,
  myChatMemberUpdate,
  successfulPaymentUpdate,
  textUpdate,
} from '../testHarness.js';

const MEMBER = 222;

describe('/delete_account', () => {
  it('deletes the personal ledger and keeps the group totals under a deleted member', async () => {
    const { bot, calls, db } = createTestBot();
    let updateId = 0;
    const dm = (fromId: number, text: string, messageId: number) =>
      bot.handleUpdate(textUpdate({ updateId: ++updateId, fromId, text, messageId }));
    const say = (text: string, messageId: number) =>
      bot.handleUpdate(
        groupTextUpdate({
          updateId: ++updateId,
          fromId: MEMBER,
          firstName: 'Вера',
          text,
          messageId,
        }),
      );
    const tap = (data: string) =>
      bot.handleUpdate(callbackUpdate({ updateId: ++updateId, fromId: MEMBER, data }));

    await bot.handleUpdate(
      myChatMemberUpdate({
        updateId: ++updateId,
        fromId: ALLOWED_ID,
        oldStatus: 'left',
        newStatus: 'member',
      }),
    );
    await dm(ALLOWED_ID, '/invite', 1);
    const code = db.prepare('SELECT code FROM invite_codes').pluck().get() as string;
    await dm(MEMBER, `/start ${code}`, 2);
    const userId = db
      .prepare("SELECT user_id FROM auth_identities WHERE external_id = '222'")
      .pluck()
      .get() as string;
    const personal = db
      .prepare("SELECT id FROM ledgers WHERE owner_user_id = ? AND kind = 'personal'")
      .pluck()
      .get(userId) as string;

    // Three personal expenses, one of them a receipt with an item.
    await dm(MEMBER, '450 кофе', 3);
    await dm(MEMBER, '120 хлеб', 4);
    await dm(MEMBER, buildRsUrl({ issuedMs: Date.parse('2026-09-29T10:00:00Z') }), 5);
    db.prepare(
      `INSERT INTO receipt_items (receipt_id, position, name, quantity, total_minor)
       SELECT id, 1, 'Hljeb', '1', 240 FROM receipts`,
    ).run();
    // Two group expenses.
    await say('450 кафе', 10);
    await say('120 такси', 11);
    // One donation, which a refund needs after the deletion.
    await bot.handleUpdate(
      successfulPaymentUpdate({
        updateId: ++updateId,
        stars: 50,
        chargeId: 'charge-1',
        fromId: MEMBER,
      }),
    );
    const donations = () =>
      db
        .prepare('SELECT stars, telegram_payment_charge_id FROM donations WHERE user_id = ?')
        .all(userId);
    expect(donations()).toEqual([{ stars: 50, telegram_payment_charge_id: 'charge-1' }]);
    const count = (sql: string) => db.prepare(sql).pluck().get(personal);
    expect(count('SELECT COUNT(*) FROM expenses WHERE ledger_id = ?')).toBe(3);

    calls.length = 0;
    await dm(MEMBER, '/delete_account', 6);
    expect(calls).toMatchObject([
      {
        payload: {
          text: messages.deleteAccountPrompt(14),
          reply_markup: {
            inline_keyboard: [
              [
                { text: messages.deleteAccountButton, callback_data: 'acct:del' },
                { text: messages.cancelButton, callback_data: 'acct:keep' },
              ],
            ],
          },
        },
      },
    ]);

    calls.length = 0;
    await tap('acct:del');
    await tap('acct:del');
    expect(calls.filter((c) => c.method === 'answerCallbackQuery')).toMatchObject([
      { payload: { text: messages.accountDeletedToast } },
      { payload: { text: messages.accountAlreadyDeleted } },
    ]);

    expect(count('SELECT COUNT(*) FROM expenses WHERE ledger_id = ?')).toBe(0);
    expect(
      count(
        'SELECT COUNT(*) FROM receipts r JOIN expenses e ON e.id = r.expense_id WHERE e.ledger_id = ?',
      ),
    ).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM receipts').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM receipt_items').pluck().get()).toBe(0);
    expect(count('SELECT COUNT(*) FROM ledgers WHERE id = ?')).toBe(0);
    expect(count('SELECT COUNT(*) FROM categories WHERE ledger_id = ?')).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) FROM auth_identities WHERE user_id = ?').pluck().get(userId),
    ).toBe(0);
    expect(
      db
        .prepare('SELECT admitted_at, active_ledger_id, deleted_at FROM users WHERE id = ?')
        .get(userId),
    ).toEqual({
      admitted_at: null,
      active_ledger_id: null,
      deleted_at: '2026-09-29T22:10:00.000Z',
    });
    expect(donations()).toEqual([{ stars: 50, telegram_payment_charge_id: 'charge-1' }]);

    // The group's month: 450.00 + 120.00 = 570.00 RSD (57 000 minor units), under a deleted
    // member.
    expect(
      db
        .prepare('SELECT amount_minor FROM expenses WHERE created_by = ? ORDER BY amount_minor')
        .pluck()
        .all(userId),
    ).toEqual([12000, 45000]);
    calls.length = 0;
    await bot.handleUpdate(
      groupTextUpdate({ updateId: ++updateId, fromId: ALLOWED_ID, text: '/month', messageId: 20 }),
    );
    const report = (calls[0]?.payload as { text: string }).text;
    expect(report).toContain('570.00 RSD');
    expect(report).toContain(`${messages.deletedMember}: 570.00 RSD`);
    expect(report).not.toContain('Вера');

    // The same Telegram id is a stranger again.
    calls.length = 0;
    await dm(MEMBER, '450 кофе', 7);
    expect(calls).toMatchObject([{ payload: { chat_id: MEMBER, text: messages.invitationOnly } }]);
  });

  it('[Отмена] deletes nothing', async () => {
    const { bot, calls, db } = createTestBot();
    await bot.handleUpdate(textUpdate({ updateId: 1, text: '450 кофе' }));
    await bot.handleUpdate(textUpdate({ updateId: 2, text: '/delete_account' }));
    calls.length = 0;

    await bot.handleUpdate(callbackUpdate({ updateId: 3, data: 'acct:keep' }));

    expect(calls.filter((c) => c.method === 'editMessageText')).toMatchObject([
      { payload: { text: messages.accountKept } },
    ]);
    expect(db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(1);
    expect(
      db.prepare('SELECT COUNT(*) FROM users WHERE deleted_at IS NOT NULL').pluck().get(),
    ).toBe(0);
  });
});
