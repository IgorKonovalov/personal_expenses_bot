import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Expense, ExpenseId } from '../../db/expenses.js';
import type { Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import type { CurrencyCode } from '../../domain/currencies.js';
import type { FetchedItem } from '../../domain/receipts/types.js';
import { localDateOf, type LocalDate } from '../../domain/time.js';
import { memberBudgetStatus } from '../../services/budget.js';
import {
  receiptItems,
  receiptSummary,
  type ReceiptSummary,
} from '../../services/fetchDueReceipt.js';
import { currentAnchor, type Screen } from '../../services/flowSessions.js';
import { foldedReceipt, isLocked } from '../../services/ledgerKeys.js';
import { effectiveTimezone, restoreExpense, undoExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import {
  DRILL_BACK,
  RESTORE_EXPENSE,
  UNDO_EXPENSE,
  categoryPickerData,
  editExpenseData,
  receiptItemsData,
  receiptRetryData,
  repeatExpenseData,
  restoreExpenseData,
  undoExpenseData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, type Html } from '../render/html.js';
import { backRow } from '../screens.js';
import { registerEdit } from './edit.js';
import { registerReceiptCard } from './receipt.js';
import { ensureUser } from './start.js';

// An expense card (ADR-0011): the message about one expense. It is edited in place between its
// recorded form, with [Категория], [Изменить] and [Удалить], its category picker, its edit
// field picker and prompts, and its deleted form, with [Вернуть].

export interface CardView {
  readonly expense: Expense;
  readonly ledger: Ledger;
  // The viewer's local date of occurred_at, the day they sent it. A card for an expense dated
  // otherwise names its date.
  readonly sentOn: LocalDate;
  // What's left of the ledger's overall limit, as of now: absent for a deleted expense or a
  // ledger without a limit.
  readonly budget?: CardBudget;
  // The expense's category against its cap: absent for a deleted expense or an uncapped
  // category.
  readonly cap?: CardCap;
  // The receipt behind the expense: absent for a deleted expense or one typed in. A fetched
  // receipt carries its items when the viewer may read them (the author, the ledger open).
  readonly receipt?: ReceiptSummary & { readonly items?: readonly FetchedItem[] };
  // The viewer is the author: the card offers [Повторять].
  readonly repeatable?: boolean;
}

export interface CardCap {
  readonly name: string;
  readonly spentMinor: number;
  readonly capMinor: number;
  readonly currency: CurrencyCode;
}

export interface CardBudget {
  readonly currency: CurrencyCode;
  readonly todayLeftMinor: number;
  readonly periodLeftMinor: number;
  readonly to: LocalDate;
}

export interface Card {
  readonly text: Html;
  readonly markup: InlineKeyboard;
}

// The budget figures are read on every render, so a card re-rendered after an edit, a category
// change or a restore shows current numbers.
export function cardView(
  deps: HandlerDeps,
  user: User,
  { expense, ledger }: { readonly expense: Expense; readonly ledger: Ledger },
): CardView {
  const view = {
    expense,
    ledger,
    sentOn: localDateOf(expense.occurredAt, effectiveTimezone(deps, user, ledger)),
    repeatable: expense.createdBy === user.id,
  };
  if (expense.deletedAt !== null) return view;
  const receipt = receiptSummary(deps, expense.id) ?? foldedReceiptSummary(deps, expense.id);
  const withReceipt =
    receipt === undefined ? view : { ...view, receipt: withItems(deps, user, expense, receipt) };
  const status = memberBudgetStatus(deps, { user, ledger, now: deps.now() });
  // A sealed ledger's card right after recording, while locked, shows no budget line.
  if (status === undefined || isLocked(status)) return withReceipt;
  const { currency, limit } = status;
  const cap = status.caps.find((c) => c.categoryId === expense.category?.id);
  return {
    ...withReceipt,
    ...(limit === undefined
      ? {}
      : {
          budget: {
            currency,
            todayLeftMinor: limit.todayLeftMinor,
            periodLeftMinor: limit.periodLeftMinor,
            to: status.period.to,
          },
        }),
    ...(cap === undefined ? {} : { cap: { ...cap, currency } }),
  };
}

// A sealed row's receipt lives in its payload (ADR-0020): shown as fetched once it has a seller.
// Only a fetched receipt offers anything; a failed one is not retried after sealing.
function foldedReceiptSummary(deps: HandlerDeps, expenseId: ExpenseId): ReceiptSummary | undefined {
  const folded = foldedReceipt(deps, expenseId);
  if (folded === undefined || folded.sellerName === null) return undefined;
  return { state: 'fetched', sellerName: folded.sellerName, itemCount: folded.items.length };
}

// A fetched receipt's items, read the way [Позиции] reads them: only the author gets them, and
// a locked sealed ledger gives none.
function withItems(
  deps: HandlerDeps,
  user: User,
  expense: Expense,
  receipt: ReceiptSummary,
): NonNullable<CardView['receipt']> {
  if (receipt.state !== 'fetched' || expense.createdBy !== user.id) return receipt;
  const read = receiptItems(deps, { user, expenseId: expense.id });
  return read.kind === 'items' ? { ...receipt, items: read.items } : receipt;
}

// [Категория] [Изменить] above [Удалить]: the destructive button gets its own row (ADR-0011).
// The author's card adds [Повторять] on a row between them, and a receipt expense adds
// [Позиции] once fetched, unless its items fold into the card (ADR-0038), or [Повторить] once
// the fetch gave up, on the next.
export function recordedCard(view: CardView): Card {
  const id = view.expense.id;
  const markup = new InlineKeyboard()
    .text(messages.categoryButton, categoryPickerData(id))
    .text(messages.editButton, editExpenseData(id))
    .row();
  if (view.repeatable === true) markup.text(messages.repeatButton, repeatExpenseData(id)).row();
  if (view.receipt?.state === 'fetched') {
    if (!messages.foldsReceiptItems(view)) {
      markup.text(messages.receiptItemsButton, receiptItemsData(id, 1)).row();
    }
  } else if (view.receipt?.state === 'failed') {
    markup.text(messages.receiptRetryButton, receiptRetryData(id)).row();
  }
  return {
    text: messages.expenseRecorded(view),
    markup: markup.text(messages.undoButton, undoExpenseData(id)),
  };
}

export function deletedCard(view: CardView): Card {
  return {
    text: messages.expenseUndone(view),
    markup: new InlineKeyboard().text(messages.restoreButton, restoreExpenseData(view.expense.id)),
  };
}

// The card for the expense's stored state.
export function cardFor(view: CardView): Card {
  return view.expense.deletedAt === null ? recordedCard(view) : deletedCard(view);
}

export interface MessageRef {
  readonly chatId: number;
  readonly messageId: number;
}

// The message a callback was tapped on.
export function tappedMessage(ctx: Context): MessageRef | undefined {
  const message = ctx.callbackQuery?.message;
  return message === undefined
    ? undefined
    : { chatId: message.chat.id, messageId: message.message_id };
}

// The anchor's screen holds this expense's card inside a summary drill-down (Plan 0037).
function showsInDrill(screen: Screen, expenseId: ExpenseId): boolean {
  return (
    screen.name === 'summary' &&
    screen.drill?.level === 'list' &&
    screen.drill.expenseId === expenseId
  );
}

// ADR-0040: every card a callback or a flow answer re-renders goes through here. Drawn into `at`
// while `at` is the user's anchor and the anchor holds this expense in a summary drill-down, the
// card gets [« Назад] (`drl:back`) on its own bottom row, and a viewer who isn't the author, for
// whom every card action is refused, gets [« Назад] alone. Anywhere else the card is unchanged.
export function cardAt(
  deps: HandlerDeps,
  user: User,
  at: MessageRef | undefined,
  view: CardView,
  card: Card,
): Card {
  if (at === undefined) return card;
  const anchor = currentAnchor(deps, user);
  if (
    anchor === undefined ||
    anchor.chatId !== at.chatId ||
    anchor.messageId !== at.messageId ||
    !showsInDrill(anchor.screen, view.expense.id)
  ) {
    return card;
  }
  const back = backRow(DRILL_BACK);
  return {
    text: card.text,
    markup: InlineKeyboard.from(
      view.expense.createdBy === user.id ? [...card.markup.inline_keyboard, back] : [back],
    ),
  };
}

export function expenseIdOf(match: string | RegExpMatchArray): ExpenseId | undefined {
  return typeof match === 'string' ? undefined : (match[1] as ExpenseId | undefined);
}

// The edit flow's and the receipt's taps on the card are registered with it.
export function registerCard(bot: Composer<Context>, deps: HandlerDeps): void {
  registerEdit(bot, deps);
  registerReceiptCard(bot, deps);

  bot.callbackQuery(UNDO_EXPENSE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = undoExpense(deps, { user, expenseId, now });

    switch (result.kind) {
      case 'undone': {
        await ctx.answerCallbackQuery({ text: messages.undoneToast });
        const view = cardView(deps, user, result);
        const card = cardAt(deps, user, tappedMessage(ctx), view, deletedCard(view));
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'alreadyUndone':
        await ctx.answerCallbackQuery({ text: messages.alreadyUndone });
        return;
      case 'locked':
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.undoForbidden });
        return;
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.expenseNotFound });
        return;
    }
  });

  bot.callbackQuery(RESTORE_EXPENSE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const result = restoreExpense(deps, { user, expenseId });

    switch (result.kind) {
      case 'restored': {
        await ctx.answerCallbackQuery({ text: messages.restoredToast });
        const view = cardView(deps, user, result);
        const card = cardAt(deps, user, tappedMessage(ctx), view, recordedCard(view));
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'alreadyRestored':
        await ctx.answerCallbackQuery({ text: messages.alreadyRestored });
        return;
      case 'locked':
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.restoreForbidden });
        return;
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.expenseNotFound });
        return;
    }
  });
}
