import { GrammyError, InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Expense, ExpenseId } from '../../db/expenses.js';
import type { Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { localDateOf } from '../../domain/time.js';
import { isAdmitted } from '../../services/admission.js';
import { showExpense } from '../../services/changeCategory.js';
import { isAccountDeleted } from '../../services/deleteAccount.js';
import { boundLedger } from '../../services/groupChats.js';
import { plaintext } from '../../services/ledgerKeys.js';
import {
  findExpenseForSource,
  findTelegramUser,
  resolveLedgerTimezone,
  restoreExpense,
  undoExpense,
} from '../../services/recordExpense.js';
import type { RuleId } from '../../db/recurring.js';
import { parseLocalDate } from '../../domain/time.js';
import { answerAsk } from '../../services/recurring.js';
import {
  ASK_RECORD,
  ASK_SKIP,
  GROUP_DELETE,
  GROUP_RESTORE,
  groupDeleteData,
  groupRestoreData,
} from '../callbackData.js';
import { expenseIdOf, type Card } from '../handlers/card.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';
import { fromPerson } from './text.js';

// The group card (ADR-0014): one group expense, replied to the message that recorded it. Its
// buttons act for the expense's author only. [Удалить] and [Вернуть] work in the group;
// [Изменить в личке] deep-links to the author's DM card, and is shown only to an admitted
// author, since the DM stays closed to everyone else (ADR-0024).

export interface GroupCardView {
  readonly expense: Expense;
  // The author's Telegram first name.
  readonly author: string;
  // Whether the author can open the bot's DM.
  readonly authorAdmitted: boolean;
}

// `https://t.me/<bot>?start=e_<uuid>`: a 38-byte payload, under Telegram's 64.
export function editInDmLink(botUsername: string, expenseId: ExpenseId): string {
  return `https://t.me/${botUsername}?start=e_${expenseId}`;
}

function messageView(deps: GroupHandlerDeps, view: GroupCardView, ledger: Ledger) {
  const timezone =
    ledger.timezone === null
      ? deps.defaultTimezone
      : resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
  return {
    author: view.author,
    expense: view.expense,
    sentOn: localDateOf(view.expense.occurredAt, timezone),
  };
}

export function groupCard(
  deps: GroupHandlerDeps,
  ctx: Context,
  view: GroupCardView,
  ledger: Ledger,
): Card {
  const shown = messageView(deps, view, ledger);
  const { id } = view.expense;
  if (view.expense.deletedAt !== null) {
    return {
      text: messages.groupExpenseDeleted(shown),
      markup: new InlineKeyboard().text(messages.restoreButton, groupRestoreData(id)),
    };
  }
  const markup = new InlineKeyboard().text(messages.undoButton, groupDeleteData(id));
  if (view.authorAdmitted) {
    markup.url(messages.groupEditInDmButton, editInDmLink(ctx.me.username, id));
  }
  return { text: messages.groupExpenseCard(shown), markup };
}

// Replies the card to the message that recorded the expense.
export async function replyGroupCard(
  deps: GroupHandlerDeps,
  ctx: Context,
  view: GroupCardView & { readonly ledger: Ledger; readonly replyTo: number },
): Promise<void> {
  const card = groupCard(deps, ctx, view, view.ledger);
  await replyHtml(ctx, card.text, {
    reply_markup: card.markup,
    reply_parameters: { message_id: view.replyTo },
  });
}

// The quiet confirmation: a reaction on the message. False when Telegram refuses it, e.g. a chat
// with reactions turned off, so the caller sends the card instead.
export async function reacted(ctx: Context, messageId: number): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  try {
    await ctx.api.setMessageReaction(chatId, messageId, [
      { type: 'emoji', emoji: messages.groupRecordedReaction },
    ]);
    return true;
  } catch (error) {
    if (error instanceof GrammyError) return false;
    throw error;
  }
}

export function registerGroupCard(group: Composer<Context>, deps: GroupHandlerDeps): void {
  // `/card` replied to a message shows the card of the expense it recorded; otherwise nothing.
  group.command('card', async (ctx) => {
    const replied = ctx.message?.reply_to_message;
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    if (replied?.from === undefined) return;
    const ledger = boundLedger(deps, ctx.chat.id);
    if (ledger === undefined) return;
    const stored = findExpenseForSource(deps, `tg:${ctx.chat.id}:${replied.message_id}`);
    if (stored?.ledgerId !== ledger.id) return;
    // A group's ledger is shared, and a shared ledger is never sealed.
    const expense = plaintext(stored);
    await replyGroupCard(deps, ctx, {
      expense,
      author: isAccountDeleted(deps, expense.createdBy)
        ? messages.deletedMember
        : replied.from.first_name,
      authorAdmitted: isAdmitted(deps, replied.from.id),
      ledger,
      replyTo: replied.message_id,
    });
  });

  group.callbackQuery(GROUP_DELETE, async (ctx) => {
    const tap = authorTap(deps, ctx);
    if (tap === undefined) {
      await ctx.answerCallbackQuery({ text: messages.groupNotAuthor });
      return;
    }
    const result = undoExpense(deps, { user: tap.user, expenseId: tap.expenseId, now: deps.now() });
    switch (result.kind) {
      case 'undone': {
        await ctx.answerCallbackQuery({ text: messages.undoneToast });
        const card = groupCard(
          deps,
          ctx,
          {
            expense: { ...result.expense, deletedAt: deps.now() },
            author: ctx.from.first_name,
            authorAdmitted: false,
          },
          result.ledger,
        );
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'alreadyUndone':
        await ctx.answerCallbackQuery({ text: messages.alreadyUndone });
        return;
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.groupNotAuthor });
        return;
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.expenseNotFound });
        return;
    }
  });

  // An `ask` occurrence's prompt in the group: only the rule's author answers it.
  const answerAskInGroup = async (
    ctx: Context & { match: string | RegExpMatchArray },
    answer: { readonly kind: 'record' } | { readonly kind: 'skip' },
  ) => {
    const ruleId = ctx.match[1] as RuleId | undefined;
    const dueOn = parseLocalDate(ctx.match[2] ?? '');
    const user = ctx.from === undefined ? undefined : findTelegramUser(deps, ctx.from.id);
    if (ruleId === undefined || dueOn === undefined) return;
    if (user === undefined) {
      await ctx.answerCallbackQuery({ text: messages.groupNotAuthor });
      return;
    }
    const result = answerAsk(deps, { user, ruleId, dueOn, now: deps.now(), answer });
    switch (result.kind) {
      case 'recorded': {
        await ctx.answerCallbackQuery({ text: messages.askRecordedToast });
        const card = groupCard(
          deps,
          ctx,
          {
            // A shared ledger is never sealed (ADR-0020).
            expense: plaintext(result.expense),
            author: ctx.from?.first_name ?? '',
            authorAdmitted: false,
          },
          result.ledger,
        );
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'skipped':
        await ctx.answerCallbackQuery();
        await editHtml(ctx, messages.recurringSkipped(result.rule.template?.description ?? ''));
        return;
      case 'answered':
        await ctx.answerCallbackQuery({ text: messages.askAnswered });
        return;
      default:
        await ctx.answerCallbackQuery({ text: messages.groupNotAuthor });
        return;
    }
  };
  group.callbackQuery(ASK_RECORD, (ctx) => answerAskInGroup(ctx, { kind: 'record' }));
  group.callbackQuery(ASK_SKIP, (ctx) => answerAskInGroup(ctx, { kind: 'skip' }));

  group.callbackQuery(GROUP_RESTORE, async (ctx) => {
    const tap = authorTap(deps, ctx);
    if (tap === undefined) {
      await ctx.answerCallbackQuery({ text: messages.groupNotAuthor });
      return;
    }
    const result = restoreExpense(deps, { user: tap.user, expenseId: tap.expenseId });
    switch (result.kind) {
      case 'restored': {
        await ctx.answerCallbackQuery({ text: messages.restoredToast });
        const card = groupCard(
          deps,
          ctx,
          {
            expense: result.expense,
            author: ctx.from.first_name,
            authorAdmitted: isAdmitted(deps, ctx.from.id),
          },
          result.ledger,
        );
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'alreadyRestored':
        await ctx.answerCallbackQuery({ text: messages.alreadyRestored });
        return;
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.groupNotAuthor });
        return;
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.expenseNotFound });
        return;
    }
  });
}

// The tapper as a known user, and the tapped expense when it belongs to this chat's ledger. A
// tapper who never recorded anything is nobody's author, and is not provisioned. An expense of
// another ledger is never acted on, so a card here can't print a personal expense.
function authorTap(
  deps: GroupHandlerDeps,
  ctx: Context & { match: string | RegExpMatchArray },
): { readonly user: User; readonly expenseId: ExpenseId } | undefined {
  const expenseId = expenseIdOf(ctx.match);
  const chatId = ctx.chat?.id;
  if (expenseId === undefined || chatId === undefined || ctx.from === undefined) return undefined;
  const user = findTelegramUser(deps, ctx.from.id);
  const ledger = boundLedger(deps, chatId);
  if (user === undefined || ledger === undefined) return undefined;
  const shown = showExpense(deps, { user, expenseId });
  if (shown.kind !== 'card' || shown.ledger.id !== ledger.id) return undefined;
  return { user, expenseId };
}
