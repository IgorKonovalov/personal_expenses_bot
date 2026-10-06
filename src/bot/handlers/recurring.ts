import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import { localDateOf } from '../../domain/time.js';
import { effectiveTimezone } from '../../services/recordExpense.js';
import {
  createRuleFromExpense,
  listRules,
  repeatOptions,
  type RepeatRefusal,
  type ScheduleChoice,
} from '../../services/recurring.js';
import { resolveUserTimezone } from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import {
  REPEAT_EXPENSE,
  REPEAT_SCHEDULE,
  repeatScheduleData,
  showExpenseData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, joinHtml, replyHtml, type Html } from '../render/html.js';
import { backRow } from '../screens.js';
import { cardView, expenseIdOf, recordedCard } from './card.js';
import { ensureUser } from './start.js';

// Recurring expenses (Plan 0025): [Повторять] on an expense card turns the card into a schedule
// picker, and a schedule makes the rule; /recurring lists the user's rules. Like every card
// action these work on any card however old: the expense's stored state is the guard.

const refusalToast: Record<RepeatRefusal['kind'], string> = {
  notFound: messages.expenseNotFound,
  forbidden: messages.repeatForbidden,
  deleted: messages.expenseDeletedToast,
  unavailable: messages.repeatUnavailable,
  locked: messages.ledgerLockedToast,
};

export function recurringListText(deps: HandlerDeps, user: User): Html {
  const today = localDateOf(deps.now(), resolveUserTimezone(deps, user));
  const rules = listRules(deps, user).flatMap(({ rule }) =>
    rule.template === null
      ? []
      : [
          {
            description: rule.template.description,
            money: { amountMinor: rule.template.amountMinor, currency: rule.template.currency },
            schedule: rule.schedule,
            nextDueOn: rule.nextDueOn,
          },
        ],
  );
  return messages.recurringList({ rules, today });
}

export function registerRecurring(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('recurring', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    await replyHtml(ctx, recurringListText(deps, user));
  });

  bot.callbackQuery(REPEAT_EXPENSE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    if (expenseId === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const found = repeatOptions(deps, { user, expenseId });
    if (found.kind !== 'repeatable') {
      await ctx.answerCallbackQuery({ text: refusalToast[found.kind] });
      return;
    }
    await ctx.answerCallbackQuery();
    await editHtml(ctx, messages.repeatPicker(found), {
      reply_markup: InlineKeyboard.from([
        ...found.schedules.map(({ choice, schedule }) => [
          InlineKeyboard.text(
            messages.scheduleLabel(schedule),
            repeatScheduleData(expenseId, choice),
          ),
        ]),
        backRow(showExpenseData(expenseId)),
      ]),
    });
  });

  // A second tap finds the rule the first one made and shows the same card.
  bot.callbackQuery(REPEAT_SCHEDULE, async (ctx) => {
    const expenseId = expenseIdOf(ctx.match);
    const choice = ctx.match[2] as ScheduleChoice | undefined;
    if (expenseId === undefined || choice === undefined) return;
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const result = createRuleFromExpense(deps, { user, expenseId, choice, now });
    if (result.kind !== 'created') {
      await ctx.answerCallbackQuery({ text: refusalToast[result.kind] });
      return;
    }
    await ctx.answerCallbackQuery();
    const card = recordedCard(cardView(deps, user, result));
    const today = localDateOf(now, effectiveTimezone(deps, user, result.ledger));
    await editHtml(
      ctx,
      joinHtml(
        [
          card.text,
          messages.recurringCreated({
            schedule: result.rule.schedule,
            nextDueOn: result.rule.nextDueOn,
            today,
          }),
        ],
        '\n',
      ),
      { reply_markup: card.markup },
    );
  });
}
