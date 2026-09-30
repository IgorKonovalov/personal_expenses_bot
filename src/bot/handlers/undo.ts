import type { Composer, Context } from 'grammy';
import type { ExpenseId } from '../../db/expenses.js';
import { undoExpense } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { UNDO_EXPENSE } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml } from '../render/html.js';
import { ensureUser } from './start.js';

export function registerUndo(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(UNDO_EXPENSE, async (ctx) => {
    const expenseId = typeof ctx.match === 'string' ? undefined : ctx.match[1];
    if (expenseId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = undoExpense(deps, { user, expenseId: expenseId as ExpenseId, now });

    switch (result.kind) {
      case 'undone':
        await ctx.answerCallbackQuery({ text: messages.undoneToast });
        // Replacing the text without reply_markup also removes the Undo button.
        await editHtml(ctx, messages.expenseUndone(result));
        return;
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

  // Unknown or stale buttons: acknowledge so the client stops spinning, do nothing.
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
