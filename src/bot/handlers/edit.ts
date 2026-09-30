import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Expense } from '../../db/expenses.js';
import { addDays } from '../../domain/dateText.js';
import type { LocalDate } from '../../domain/time.js';
import {
  openEdit,
  setDateFromButton,
  startEdit,
  type EditAnswerRefusal,
  type EditRefusal,
} from '../../services/editExpense.js';
import { setAnchor, type EditFlow } from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import {
  EDIT_EXPENSE,
  EDIT_FIELD,
  SET_EXPENSE_DATE,
  editFieldData,
  setExpenseDateData,
  showExpenseData,
  type EditField,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, joinHtml, type Html } from '../render/html.js';
import { backRow, type ScreenView } from '../screens.js';
import { cardView, expenseIdOf, recordedCard } from './card.js';
import { ensureUser } from './start.js';

// Editing an expense from its card (ADR-0011): [Изменить] turns the card into a field picker, a
// field turns it into that field's prompt and makes it the flow's anchor (ADR-0009). flows.ts
// takes the typed answer; the date prompt's quick buttons are handled here. Like every card
// action, these work on any card however old: the expense's stored state is the guard.

const refusalToast: Record<EditRefusal['kind'], string> = {
  notFound: messages.expenseNotFound,
  forbidden: messages.editForbidden,
  deleted: messages.expenseDeletedToast,
};

const FIELD_FLOWS: Record<EditField, EditFlow['kind']> = {
  a: 'editAmount',
  d: 'editDescription',
  t: 'editDate',
};

function refusalLine(refusal: EditAnswerRefusal): Html {
  if (refusal.reason === 'ambiguousAmount') {
    return messages.editRefused.ambiguousAmount(
      refusal.readings.map((r) => ({ amountMinor: r.amountMinor, currency: refusal.currency })),
    );
  }
  return messages.editRefused[refusal.reason];
}

// The field's prompt in the card, naming the current value, with a refusal line above it when
// an answer failed. The date prompt offers today and the two days before as absolute dates.
export function editPromptView(
  kind: EditFlow['kind'],
  expense: Expense,
  today: LocalDate,
  refusal?: EditAnswerRefusal,
): ScreenView {
  const prompt =
    kind === 'editAmount'
      ? messages.amountPrompt(expense)
      : kind === 'editDescription'
        ? messages.descriptionPrompt(expense.description)
        : messages.datePrompt({ date: expense.occurredOn, today });
  const quick =
    kind === 'editDate'
      ? [
          [
            InlineKeyboard.text(messages.todayButton, setExpenseDateData(expense.id, today)),
            InlineKeyboard.text(
              messages.yesterdayButton,
              setExpenseDateData(expense.id, addDays(today, -1)),
            ),
            InlineKeyboard.text(
              messages.dayBeforeButton,
              setExpenseDateData(expense.id, addDays(today, -2)),
            ),
          ],
        ]
      : [];
  // [Отмена] is a card action, not the screen's flow:cancel: it must still restore the card after
  // the anchor has moved elsewhere (a menu tap, another screen, another card's edit).
  return {
    text: refusal === undefined ? prompt : joinHtml([refusalLine(refusal), prompt], '\n'),
    markup: InlineKeyboard.from([
      ...quick,
      [InlineKeyboard.text(messages.cancelButton, showExpenseData(expense.id))],
    ]),
  };
}

export function registerEdit(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.callbackQuery(EDIT_EXPENSE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const found = openEdit(deps, { user, expenseId });
    if (found.kind !== 'editable') {
      await ctx.answerCallbackQuery({ text: refusalToast[found.kind] });
      return;
    }
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.editPicker(found), {
      reply_markup: InlineKeyboard.from([
        [
          InlineKeyboard.text(messages.editAmountButton, editFieldData(expenseId, 'a')),
          InlineKeyboard.text(messages.editDescriptionButton, editFieldData(expenseId, 'd')),
          InlineKeyboard.text(messages.editDateButton, editFieldData(expenseId, 't')),
        ],
        backRow(showExpenseData(expenseId)),
      ]),
    });
  });

  bot.callbackQuery(EDIT_FIELD, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    const field = ctx.match[2] as EditField | undefined;
    const card = ctx.callbackQuery.message;
    if (expenseId === undefined || field === undefined || card === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const kind = FIELD_FLOWS[field];
    const started = startEdit(deps, { user, expenseId, kind, now });
    if (started.kind !== 'editable') {
      await ctx.answerCallbackQuery({ text: refusalToast[started.kind] });
      return;
    }
    // The card becomes the anchor: the typed answer and /cancel re-render it.
    setAnchor(deps, user, {
      chatId: card.chat.id,
      messageId: card.message_id,
      screen: { name: 'expense', expenseId },
    });
    await ctx.answerCallbackQuery();
    const view = editPromptView(kind, started.expense, started.today);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(SET_EXPENSE_DATE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = setDateFromButton(deps, { user, expenseId, date: ctx.match[2] ?? '', now });
    switch (result.kind) {
      case 'editable': {
        await ctx.answerCallbackQuery({
          text: result.changed ? messages.expenseEditedToast : messages.dateUnchanged,
        });
        const card = recordedCard(cardView(deps, user, result));
        await editHtml(ctx, card.text, { reply_markup: card.markup });
        return;
      }
      case 'unavailable':
        await ctx.answerCallbackQuery({ text: messages.dateUnavailable });
        return;
      default:
        await ctx.answerCallbackQuery({ text: refusalToast[result.kind] });
        return;
    }
  });
}
