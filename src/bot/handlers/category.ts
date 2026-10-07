import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { CategoryId } from '../../db/categories.js';
import type { ExpenseId } from '../../db/expenses.js';
import {
  changeCategory,
  openCategoryPicker,
  showExpense,
  type CategoryPickerResult,
} from '../../services/changeCategory.js';
import { cancelFlowIf, isEditOf } from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import {
  CATEGORY_PAGE,
  CATEGORY_PICKER,
  SET_CATEGORY,
  SHOW_EXPENSE,
  categoryPageData,
  setCategoryData,
  showExpenseData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow, pickerKeyboard } from '../nav.js';
import { editHtml } from '../render/html.js';
import { cardAt, cardFor, cardView, expenseIdOf, recordedCard, tappedMessage } from './card.js';
import { ensureUser } from './start.js';

// The category picker on an expense card. It edits the card in place and, like every card
// action, works on any card however old (ADR-0011).

type Refused = Exclude<CategoryPickerResult, { kind: 'picker' }>;

const refusalToast: Record<Refused['kind'], string> = {
  notFound: messages.expenseNotFound,
  forbidden: messages.categoryForbidden,
  deleted: messages.expenseDeletedToast,
  locked: messages.ledgerLockedToast,
};

async function showPicker(ctx: Context, deps: HandlerDeps, expenseId: ExpenseId, page: number) {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const result = openCategoryPicker(deps, { user, expenseId });
  if (result.kind !== 'picker') {
    await ctx.answerCallbackQuery({ text: refusalToast[result.kind] });
    return;
  }
  await ctx.answerCallbackQuery();
  const shown = pageOf(result.categories, page);
  const current = result.expense.category?.id;
  const choices = shown.items.map((category) =>
    InlineKeyboard.text(
      category.id === current ? messages.currentChoice(category.name) : category.name,
      setCategoryData(expenseId, category.id),
    ),
  );
  await editHtml(ctx, messages.categoryPicker(result), {
    reply_markup: pickerKeyboard(
      choices,
      pagerRow(shown, (p) => categoryPageData(expenseId, p)),
      showExpenseData(expenseId),
    ),
  });
}

export function registerCategory(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(CATEGORY_PICKER, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    await showPicker(ctx, deps, expenseId, 1);
  });

  bot.callbackQuery(CATEGORY_PAGE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    await showPicker(ctx, deps, expenseId, Number(ctx.match[2]));
  });

  bot.callbackQuery(SET_CATEGORY, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const categoryId = Number(ctx.match[2]) as CategoryId;
    const result = changeCategory(deps, { user, expenseId, categoryId, now });

    switch (result.kind) {
      case 'changed': {
        await ctx.answerCallbackQuery({ text: messages.categoryChangedToast });
        const view = cardView(deps, user, result);
        const card = cardAt(deps, user, tappedMessage(ctx), view, recordedCard(view));
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'unchanged':
        await ctx.answerCallbackQuery({ text: messages.categoryUnchanged });
        return;
      case 'unavailable':
        await ctx.answerCallbackQuery({ text: messages.categoryUnavailable });
        return;
      default:
        await ctx.answerCallbackQuery({ text: refusalToast[result.kind] });
        return;
    }
  });

  // [« Назад] from a picker and [Отмена] under an edit prompt: the card for the expense's stored
  // state. A pending edit of this expense is cancelled; any other pending flow is left alone.
  bot.callbackQuery(SHOW_EXPENSE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const result = showExpense(deps, { user, expenseId });
    if (result.kind !== 'card') {
      await ctx.answerCallbackQuery({
        text: result.kind === 'locked' ? messages.ledgerLockedToast : messages.expenseNotFound,
      });
      return;
    }
    cancelFlowIf(deps, user, isEditOf(expenseId));
    await ctx.answerCallbackQuery();
    const view = cardView(deps, user, result);
    const card = cardAt(deps, user, tappedMessage(ctx), view, cardFor(view));
    await editHtml(ctx, card.text, { reply_markup: card.markup });
  });
}
