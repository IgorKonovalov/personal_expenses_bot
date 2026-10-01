import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { parsePeriod, type Period } from '../../domain/periods.js';
import { groupBudgetStatus } from '../../services/budget.js';
import { groupPeriodSummary, type PeriodSummary } from '../../services/periodSummary.js';
import { groupTodaySummary } from '../../services/todaySummary.js';
import { SUMMARY_PAGE, summaryPageData } from '../callbackData.js';
import { messages } from '../messages.js';
import { editHtml, replyHtml, type Html } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';
import { fromPerson } from './text.js';

// /today, /week, /month and /budget in a bound group: the group ledger in its timezone, with a section
// per person. The pager is stateless: the ledger comes from the chat's binding, so a tap writes
// no ADR-0011 anchor and works for anyone in the group.

function summaryView(summary: PeriodSummary): { text: Html; markup: InlineKeyboard } {
  const row = [
    InlineKeyboard.text(messages.periodPrev(summary.previous), summaryPageData(summary.previous)),
    ...(summary.next === undefined
      ? []
      : [InlineKeyboard.text(messages.periodNext(summary.next), summaryPageData(summary.next))]),
  ];
  return { text: messages.periodSummary(summary), markup: InlineKeyboard.from([row]) };
}

async function sendGroupSummary(
  ctx: Context,
  deps: GroupHandlerDeps,
  kind: Period['kind'],
): Promise<void> {
  if (ctx.chat === undefined || ctx.message === undefined || !fromPerson(ctx.message)) return;
  const summary = groupPeriodSummary(deps, { chatId: ctx.chat.id, kind, now: deps.now() });
  if (summary === undefined) return;
  const view = summaryView(summary);
  await replyHtml(ctx, view.text, { reply_markup: view.markup });
}

export function registerGroupSummary(group: Composer<Context>, deps: GroupHandlerDeps): void {
  group.command('today', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    const summary = groupTodaySummary(deps, { chatId: ctx.chat.id, now: deps.now() });
    if (summary === undefined) return;
    await replyHtml(ctx, messages.today(summary));
  });
  // Read-only: the budget is set from the ledger's settings in the owner's DM.
  group.command('budget', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    const view = groupBudgetStatus(deps, { chatId: ctx.chat.id, now: deps.now() });
    if (view === undefined) return;
    await replyHtml(ctx, messages.groupBudget(view));
  });
  group.command('week', (ctx) => sendGroupSummary(ctx, deps, 'week'));
  group.command('month', (ctx) => sendGroupSummary(ctx, deps, 'month'));

  group.callbackQuery(SUMMARY_PAGE, async (ctx) => {
    const kind = ctx.match[1] === 'm' ? 'month' : 'week';
    const period = parsePeriod(kind, ctx.match[2] ?? '');
    const chatId = ctx.chat?.id;
    const summary =
      period === undefined || chatId === undefined
        ? undefined
        : groupPeriodSummary(deps, { chatId, kind, period, now: deps.now() });
    // A forged or future period, or an unbound chat, is answered silently and edits nothing.
    await ctx.answerCallbackQuery();
    if (summary === undefined) return;
    const view = summaryView(summary);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });
}
