import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Expense, ExpenseId } from '../../db/expenses.js';
import type { Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import type { CurrencyCode } from '../../domain/currencies.js';
import { localDateOf, type LocalDate } from '../../domain/time.js';
import { memberBudgetStatus } from '../../services/budget.js';
import { receiptSummary, type ReceiptSummary } from '../../services/fetchDueReceipt.js';
import { foldedReceipt, isLocked } from '../../services/ledgerKeys.js';
import { effectiveTimezone, restoreExpense, undoExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import {
  RESTORE_EXPENSE,
  UNDO_EXPENSE,
  categoryPickerData,
  editExpenseData,
  receiptItemsData,
  receiptRetryData,
  restoreExpenseData,
  undoExpenseData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, type Html } from '../render/html.js';
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
  // The receipt behind the expense: absent for a deleted expense or one typed in.
  readonly receipt?: ReceiptSummary;
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
  };
  if (expense.deletedAt !== null) return view;
  const receipt = receiptSummary(deps, expense.id) ?? foldedReceiptSummary(deps, expense.id);
  const withReceipt = receipt === undefined ? view : { ...view, receipt };
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

// [Категория] [Изменить] above [Удалить]: the destructive button gets its own row (ADR-0011).
// A receipt expense adds [Позиции] once fetched, or [Повторить] once the fetch gave up, on a row
// between them.
export function recordedCard(view: CardView): Card {
  const id = view.expense.id;
  const markup = new InlineKeyboard()
    .text(messages.categoryButton, categoryPickerData(id))
    .text(messages.editButton, editExpenseData(id))
    .row();
  if (view.receipt?.state === 'fetched') {
    markup.text(messages.receiptItemsButton, receiptItemsData(id, 1)).row();
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
        const card = deletedCard(cardView(deps, user, result));
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
        const card = recordedCard(cardView(deps, user, result));
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
