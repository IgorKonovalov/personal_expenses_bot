import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { Ledger } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { parsePeriod } from '../../domain/periods.js';
import { localDateOf, type LocalDate } from '../../domain/time.js';
import { encodeDonut } from '../../domain/widgetData.js';
import { isLocked } from '../../services/ledgerKeys.js';
import { ledgerPeriodSummary, type PeriodSummary } from '../../services/periodSummary.js';
import { effectiveTimezone } from '../../services/recordExpense.js';
import type { HandlerDeps } from '../bot.js';
import { WIDGET_SUMMARY } from '../callbackData.js';
import { messages } from '../messages.js';
import { requireScreen } from '../screens.js';
import { replyWidget, type WidgetMessage } from '../widgetApi.js';
import { createSentMarks, sentMarkKey, type SentMarks } from '../widgets/sentMarks.js';
import { chartUrlOf } from './summary.js';

// A screen's «📈 Диаграмма» with WIDGETS on (ADR-0053): a `wg:` tap sends the screen's chart as a
// widget message below it, read from the database at tap time. The screen stays the anchor and
// is never edited. A repeat tap with the same data on the same message gets the chartAlreadySent
// toast and sends nothing (widgets/sentMarks.ts).

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
  const chatData = encodeDonut(
    messages.widgetDonut({
      title: summary.period,
      currency: converted.currency,
      totalMinor: converted.totalMinor,
      approximate: summary.convertedFrom.length > 0,
      lines: converted.lines.map((line) => ({ ...line, token: '' })),
      unconverted: unconverted.map((block) => ({
        amountMinor: block.totalMinor,
        currency: block.currency,
      })),
      drill: '',
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
    queries: false,
    ...(url === undefined
      ? {}
      : { markup: new InlineKeyboard().webApp(messages.chartDetailButton, url) }),
  };
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
