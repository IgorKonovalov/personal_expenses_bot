import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Expense, ExpenseId } from '../../db/expenses.js';
import type { Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { localDateOf, type LocalDate } from '../../domain/time.js';
import { restoreExpense, undoExpense } from '../../services/recordExpense.js';
import { resolveUserTimezone } from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import {
  RESTORE_EXPENSE,
  UNDO_EXPENSE,
  categoryPickerData,
  editExpenseData,
  restoreExpenseData,
  undoExpenseData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, type Html } from '../render/html.js';
import { registerEdit } from './edit.js';
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
}

export interface Card {
  readonly text: Html;
  readonly markup: InlineKeyboard;
}

export function cardView(
  deps: HandlerDeps,
  user: User,
  { expense, ledger }: { readonly expense: Expense; readonly ledger: Ledger },
): CardView {
  return {
    expense,
    ledger,
    sentOn: localDateOf(expense.occurredAt, resolveUserTimezone(deps, user)),
  };
}

// [Категория] [Изменить] above [Удалить]: the destructive button gets its own row (ADR-0011).
export function recordedCard(view: CardView): Card {
  return {
    text: messages.expenseRecorded(view),
    markup: new InlineKeyboard()
      .text(messages.categoryButton, categoryPickerData(view.expense.id))
      .text(messages.editButton, editExpenseData(view.expense.id))
      .row()
      .text(messages.undoButton, undoExpenseData(view.expense.id)),
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

// The edit flow's taps on the card are registered with it.
export function registerCard(bot: Composer<Context>, deps: HandlerDeps): void {
  registerEdit(bot, deps);

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
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.restoreForbidden });
        return;
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.expenseNotFound });
        return;
    }
  });
}
