import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { parsePeriod, periodKey } from '../../domain/periods.js';
import { localDateOf, parseLocalDate, type LocalDate } from '../../domain/time.js';
import { encodeBars, encodeBurndown, encodeDonut } from '../../domain/widgetData.js';
import { budgetPace, budgetScreen, type BudgetScreenView } from '../../services/budget.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { ledgerPeriodSummary, type PeriodSummary } from '../../services/periodSummary.js';
import { effectiveTimezone } from '../../services/recordExpense.js';
import { recentDayTotals, type RecentDayTotals } from '../../services/todaySummary.js';
import type { HandlerDeps } from '../bot.js';
import { WIDGET_BUDGET, WIDGET_SUMMARY, WIDGET_TODAY } from '../callbackData.js';
import { messages } from '../messages.js';
import { requireScreen } from '../screens.js';
import { replyWidget, type WidgetMessage } from '../widgetApi.js';
import { createSentMarks, sentMarkKey, type SentMarks } from '../widgets/sentMarks.js';
import { chartUrlOf as budgetChartUrlOf } from './budget.js';
import { ensureUser } from './start.js';
import { chartUrlOf } from './summary.js';

// A screen's «📈 Диаграмма» with WIDGETS on (ADR-0053): a `wg:` tap sends the screen's chart as a
// widget message below it, read from the database at tap time. The screen stays the anchor and
// is never edited. A repeat tap with the same data on the same message gets the chartAlreadySent
// toast and sends nothing (widgets/sentMarks.ts).

// The most a widget's request() may send, in UTF-8 bytes.
const WIDGET_REQUEST_BYTES = 64;

export function registerWidgetChart(bot: Composer<Context>, deps: HandlerDeps): void {
  const marks = createSentMarks(deps.now);

  // /week and /month: the period the button names, of the anchor's ledger.
  bot.callbackQuery(WIDGET_SUMMARY, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const { screen } = tap.anchor;
    if (screen.name !== 'summary') {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const period = parsePeriod(ctx.match[1] === 'm' ? 'month' : 'week', ctx.match[2] ?? '');
    const summary =
      period === undefined
        ? undefined
        : ledgerPeriodSummary(deps, {
            user: tap.user,
            ledgerId: screen.ledgerId,
            period,
            now: deps.now(),
          });
    if (isLocked(summary)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    const widget = summary === undefined ? undefined : summaryWidget(ctx, deps, tap.user, summary);
    await sendOnce(ctx, marks, widget);
  });

  // /budget: the anchor ledger's current budget period.
  bot.callbackQuery(WIDGET_BUDGET, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const { screen } = tap.anchor;
    if (screen.name !== 'budget') {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const view = budgetScreen(deps, { user: tap.user, ledgerId: screen.ledgerId, now: deps.now() });
    if (isLocked(view)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    const widget = view === undefined ? undefined : budgetWidget(ctx, deps, tap.user, view);
    await sendOnce(ctx, marks, widget);
  });

  // /today: the seven days ending at the date the screen showed, of the active ledger.
  bot.callbackQuery(WIDGET_TODAY, async (ctx) => {
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    const date = parseLocalDate(ctx.match[1] ?? '');
    const recent = date === undefined ? undefined : recentDayTotals(deps, { user, date, now });
    if (isLocked(recent)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    const widget = recent === undefined ? undefined : daysWidget(deps, user, recent);
    await sendOnce(ctx, marks, widget);
  });
}

// Answers the tap and sends `widget`, unless this message already sent it for this data. A
// forged period, or one with nothing to draw, is answered silently and sends nothing. A failed
// send forgets its mark, so the next tap tries again.
async function sendOnce(
  ctx: Context,
  marks: SentMarks,
  widget: WidgetMessage | undefined,
): Promise<void> {
  const tapped = ctx.callbackQuery?.message;
  const data = ctx.callbackQuery?.data;
  if (
    widget === undefined ||
    ctx.from === undefined ||
    tapped === undefined ||
    data === undefined
  ) {
    await ctx.answerCallbackQuery();
    return;
  }
  const key = sentMarkKey(ctx.from.id, tapped.message_id, data);
  if (!marks.mark(key)) {
    await ctx.answerCallbackQuery({ text: messages.chartAlreadySent });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    await replyWidget(ctx, widget);
  } catch (error) {
    marks.forget(key);
    throw error;
  }
}

// The donut of a period's converted block: undefined when the period has none, or it can't fit
// chatData. [🔍 Подробно] opens the Mini App chart the screen's button would have opened.
function summaryWidget(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  summary: PeriodSummary,
): WidgetMessage | undefined {
  const [converted, ...unconverted] = summary.currencies;
  if (converted?.currency !== summary.ledger.defaultCurrency) return undefined;
  // A tap on a line asks for its category's last periods (handlers/widgetQuery.ts).
  const drill = `${periodKey(summary.period)}:${summary.ledger.id}`;
  const chatData = encodeDonut(
    messages.widgetDonut({
      title: summary.period,
      currency: converted.currency,
      totalMinor: converted.totalMinor,
      approximate: summary.convertedFrom.length > 0,
      lines: converted.lines.map((line) => ({
        ...line,
        token: drillToken(drill, line.categoryId ?? 'n'),
      })),
      unconverted: unconverted.map((block) => ({
        amountMinor: block.totalMinor,
        currency: block.currency,
      })),
      drill,
    }),
    messages.widgetFold(converted.currency),
  );
  if (chatData === undefined) return undefined;
  const caption =
    messages.widgetCaption(summary.period, localAt(deps, user, summary.ledger)) +
    (summary.convertedFrom.length > 0 ? messages.widgetCaptionApprox : '');
  const url = chartUrlOf(ctx, deps, user, summary);
  return {
    program: 'donut',
    chatData,
    caption,
    queries: true,
    ...(url === undefined
      ? {}
      : { markup: new InlineKeyboard().webApp(messages.chartDetailButton, url) }),
  };
}

// The budget period's burn-down: undefined for a budget with no limit. [🔍 Подробно] opens the
// Mini App chart the screen's button would have opened.
function budgetWidget(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  view: BudgetScreenView,
): WidgetMessage | undefined {
  const pace = budgetPace(deps, { user, ledger: view.ledger, now: deps.now() });
  if (pace === undefined) return undefined;
  const { status, points } = pace;
  const input = messages.widgetBurndown({
    currency: status.currency,
    period: status.period,
    limit: status.limit,
    points,
  });
  const chatData = encodeBurndown(input);
  if (chatData === undefined) return undefined;
  const url = budgetChartUrlOf(ctx, deps, user, view);
  return {
    program: 'burndown',
    chatData,
    caption:
      messages.widgetCaption(input.title, localAt(deps, user, view.ledger)) +
      (status.converted ? messages.widgetCaptionApprox : ''),
    queries: false,
    ...(url === undefined
      ? {}
      : { markup: new InlineKeyboard().webApp(messages.chartDetailButton, url) }),
  };
}

// The seven day totals, the last one highlighted: undefined when none has converted spend. /today
// has no Mini App chart, so no keyboard.
function daysWidget(
  deps: HandlerDeps,
  user: User,
  recent: RecentDayTotals,
): WidgetMessage | undefined {
  if (!recent.days.some((day) => day.totalMinor > 0)) return undefined;
  return {
    program: 'days',
    chatData: encodeBars(
      messages.widgetDays({
        date: recent.date,
        days: recent.days,
        currency: recent.ledger.defaultCurrency,
        approximate: recent.approximate,
      }),
    ),
    caption:
      messages.widgetCaption(
        messages.widgetDaysTitle(recent.days.length, recent.date),
        localAt(deps, user, recent.ledger),
      ) + (recent.approximate ? messages.widgetCaptionApprox : ''),
    queries: false,
  };
}

// A donut line's token: `id` as a request's last part, or '' when `d:<drill>:<id>` would pass
// the 64 bytes a widget request may carry.
function drillToken(drill: string, id: number | string): string {
  return Buffer.byteLength(`d:${drill}:${id}`, 'utf8') <= WIDGET_REQUEST_BYTES ? String(id) : '';
}

// The ledger's local date and `HH:mm` now, for a caption's «на 12 ноября, 14:05».
function localAt(
  deps: HandlerDeps,
  user: User,
  ledger: Ledger,
): { readonly date: LocalDate; readonly time: string } {
  const now = deps.now();
  const zone = effectiveTimezone(deps, user, ledger);
  return { date: localDateOf(now, zone), time: format(new TZDate(now.getTime(), zone), 'HH:mm') };
}
