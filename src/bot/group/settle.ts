import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { TransferId } from '../../db/transfers.js';
import type { UserId } from '../../db/users.js';
import {
  deleteTransfer,
  joinSettle,
  recordTransfer,
  settleView,
  type SettleView,
} from '../../services/settleUp.js';
import {
  SETTLE_DELETE,
  SETTLE_JOIN,
  SETTLE_TRANSFER,
  settleDeleteData,
  settleTransferData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import type { ScreenView } from '../screens.js';
import type { GroupHandlerDeps } from './index.js';
import { fromPerson } from './text.js';

// /settle in a bound group (ADR-0030): balances and the transfers that square them, per
// currency, recomputed on every read. Stateless like the group's other screens: the ledger comes
// from the chat's binding, and a [Перевёл] tap carries the hash of the list it was shown with.

function settleScreenView(view: SettleView): ScreenView {
  const nameOf = new Map(view.members.map((m) => [m.id, m.name]));
  const name = (id: UserId) => nameOf.get(id) ?? null;
  return {
    text: messages.settleScreen({
      names: view.members.map((m) => m.name),
      currencies: view.currencies.map((c) => ({
        currency: c.currency,
        balances: c.balances,
        transfers: c.transfers.map((t) => ({
          from: name(t.from),
          to: name(t.to),
          amountMinor: t.amountMinor,
        })),
      })),
    }),
    markup: InlineKeyboard.from([
      ...view.transfers.map((t, i) => [
        InlineKeyboard.text(
          messages.settleTransferButton(name(t.from), name(t.to)),
          settleTransferData(i, view.hash),
        ),
      ]),
      [InlineKeyboard.text(messages.settleJoinButton, SETTLE_JOIN)],
    ]),
  };
}

async function rerender(ctx: Context, view: SettleView | undefined): Promise<void> {
  if (view === undefined) return;
  const screen = settleScreenView(view);
  await editHtml(ctx, screen.text, { reply_markup: screen.markup });
}

export function registerGroupSettle(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.command('settle', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    const view = settleView(deps, ctx.chat.id);
    if (view === undefined) return;
    const screen = settleScreenView(view);
    await replyHtml(ctx, screen.text, { reply_markup: screen.markup });
  });

  group.callbackQuery(SETTLE_JOIN, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const joined = joinSettle(deps, {
      chatId,
      telegramId: ctx.from.id,
      firstName: ctx.from.first_name,
      now: deps.now(),
    });
    if (joined === 'unbound') return;
    await ctx.answerCallbackQuery({
      text: joined === 'joined' ? messages.settleJoinedToast : messages.settleAlreadyJoined,
    });
    await rerender(ctx, settleView(deps, chatId));
  });

  // The recomputed list must still hash as the tapped one did: a double tap, or a tap after a
  // new expense, finds it changed and records nothing.
  group.callbackQuery(SETTLE_TRANSFER, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const result = recordTransfer(deps, {
      chatId,
      telegramId: ctx.from.id,
      index: Number(ctx.match[1]),
      hash: ctx.match[2] ?? '',
      sourceKey: `cb:${ctx.callbackQuery.id}`,
      now: deps.now(),
    });
    if (result.kind === 'notParty') {
      await ctx.answerCallbackQuery({ text: messages.settleNotParty });
      return;
    }
    if (result.kind === 'stale') {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      await rerender(ctx, result.view);
      return;
    }
    await ctx.answerCallbackQuery();
    const { transfer, view } = result;
    const nameOf = new Map(view.members.map((m) => [m.id, m.name]));
    await replyHtml(
      ctx,
      messages.transferRecorded({
        from: nameOf.get(transfer.fromUser) ?? null,
        to: nameOf.get(transfer.toUser) ?? null,
        money: { amountMinor: transfer.amountMinor, currency: transfer.currency },
      }),
      {
        reply_markup: new InlineKeyboard().text(messages.undoButton, settleDeleteData(transfer.id)),
      },
    );
    await rerender(ctx, view);
  });

  group.callbackQuery(SETTLE_DELETE, async (ctx) => {
    const chatId = ctx.chat?.id;
    const transferId = ctx.match[1] as TransferId | undefined;
    if (chatId === undefined || transferId === undefined) return;
    const result = deleteTransfer(deps, {
      chatId,
      telegramId: ctx.from.id,
      transferId,
      now: deps.now(),
    });
    if (result.kind !== 'deleted') {
      await ctx.answerCallbackQuery({
        text:
          result.kind === 'notParty'
            ? messages.settleNotParty
            : result.kind === 'alreadyDeleted'
              ? messages.transferAlreadyDeleted
              : messages.transferNotFound,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: messages.transferDeletedToast });
    await editHtml(ctx, messages.transferDeleted);
  });
}
