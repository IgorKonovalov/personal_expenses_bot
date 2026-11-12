import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { findActiveLedger, type Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { parsePeriod, periodKey } from '../../domain/periods.js';
import type { TagReport } from '../../domain/tags.js';
import { localDateOf, parseLocalDate, type LocalDate } from '../../domain/time.js';
import { encodeBars, encodeBurndown, encodeDonut } from '../../domain/widgetData.js';
import { budgetPace, budgetScreen, type BudgetScreenView } from '../../services/budget.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { ledgerPeriodSummary, type PeriodSummary } from '../../services/periodSummary.js';
import { ledgerProduct, type ProductView } from '../../services/productPrices.js';
import { effectiveTimezone } from '../../services/recordExpense.js';
import { activeLedgerTagReport } from '../../services/tagSummary.js';
import { recentDayTotals, type RecentDayTotals } from '../../services/todaySummary.js';
import type { HandlerDeps } from '../bot.js';
import {
  WIDGET_BUDGET,
  WIDGET_PRODUCT,
  WIDGET_SUMMARY,
  WIDGET_TAG,
  WIDGET_TODAY,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { requireScreen } from '../screens.js';
import { replyWidget, type WidgetMessage } from '../widgetApi.js';
import { createSentMarks, sentMarkKey, type SentMarks } from '../widgets/sentMarks.js';
import { chartUrlOf as budgetChartUrlOf } from './budget.js';
import { chartUrlOf as productChartUrlOf } from './prices.js';
import { ensureUser } from './start.js';
import { chartUrlOf } from './summary.js';
import { chartUrlOf as tagChartUrlOf } from './tags.js';

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

  // A /prices product: the ref the button names, of the anchor's ledger.
  bot.callbackQuery(WIDGET_PRODUCT, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const { screen } = tap.anchor;
    if (screen.name !== 'prices') {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const product = ledgerProduct(deps, {
      user: tap.user,
      ledgerId: screen.ledgerId,
      ref: ctx.match[1] ?? '',
    });
    if (isLocked(product)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    if (product === undefined) {
      await ctx.answerCallbackQuery({ text: messages.productGone });
      return;
    }
    await sendOnce(ctx, marks, productWidget(ctx, deps, tap.user, product));
  });

  // A tag report: the active ledger's tag the hash names, as TAG_SHOW reads it.
  bot.callbackQuery(WIDGET_TAG, async (ctx) => {
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const result = activeLedgerTagReport(deps, { user, hash: ctx.match[1] ?? '', pageSize: 1 });
    switch (result.kind) {
      case 'locked':
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      case 'gone':
        await ctx.answerCallbackQuery({ text: messages.tagGone });
        return;
      case 'report':
        await sendOnce(ctx, marks, tagWidget(ctx, deps, user, result.report));
        return;
    }
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

// A product's price per unit by month in the ledger's currency: undefined with no such month.
// [🔍 Подробно] opens the Mini App chart the screen's button would have opened.
function productWidget(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  product: ProductView,
): WidgetMessage | undefined {
  const currency = product.ledger.defaultCurrency;
  if (!product.months.some((m) => m.currency === currency)) return undefined;
  const url = productChartUrlOf(ctx, deps, product);
  return {
    program: 'days',
    chatData: encodeBars(messages.widgetProduct({ ...product, currency })),
    caption: messages.widgetCaption(product.name, localAt(deps, user, product.ledger)),
    queries: false,
    ...(url === undefined
      ? {}
      : { markup: new InlineKeyboard().webApp(messages.chartDetailButton, url) }),
  };
}

// A tag's donut of its converted block, with no taps: undefined when nothing converted, or it
// can't fit chatData.
function tagWidget(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  report: TagReport,
): WidgetMessage | undefined {
  const { converted } = report;
  const ledger = findActiveLedger(deps.db, user.id);
  if (converted === undefined || ledger === undefined) return undefined;
  const title = `#${report.name}`;
  const chatData = encodeDonut(
    messages.widgetDonut({
      title,
      currency: converted.currency,
      totalMinor: converted.totalMinor,
      approximate: report.convertedFrom.length > 0,
      lines: converted.lines.map((line) => ({ ...line, token: '' })),
      unconverted: report.unconverted.map((block) => ({
        amountMinor: block.totalMinor,
        currency: block.currency,
      })),
      drill: '',
    }),
    messages.widgetFold(converted.currency),
  );
  if (chatData === undefined) return undefined;
  const url = tagChartUrlOf(ctx, deps, report);
  return {
    program: 'donut',
    chatData,
    caption:
      messages.widgetCaption(title, localAt(deps, user, ledger)) +
      (report.convertedFrom.length > 0 ? messages.widgetCaptionApprox : ''),
    queries: false,
    ...(url === undefined
      ? {}
      : { markup: new InlineKeyboard().webApp(messages.chartDetailButton, url) }),
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
