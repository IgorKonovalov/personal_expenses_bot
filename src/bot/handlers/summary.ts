import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import { encodeChartPayload } from '../../domain/chartPayload.js';
import { parsePeriod, type Period } from '../../domain/periods.js';
import { setAnchor, type SummaryScreen } from '../../services/flowSessions.js';
import { isLocked } from '../../services/ledgerKeys.js';
import {
  currentPeriodSummary,
  ledgerPeriodSummary,
  type PeriodSummary,
} from '../../services/periodSummary.js';
import { periodChart } from '../../services/periodTrend.js';
import type { HandlerDeps } from '../bot.js';
import {
  SUMMARY_PAGE,
  drillPickerData,
  periodItemsData,
  summaryPageData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { renderAnchor, requireScreen, showScreen, type ScreenView } from '../screens.js';
import { offerTip } from '../tips.js';
import { ensureUser } from './start.js';

// /week and /month (ADR-0011 screens): a period's totals by currency and category, with a pager
// that names the neighbouring periods and pages in place. Paging reads the ledger the screen
// was opened on. [Позиции] under the pager turns the screen into the period's receipt items
// (handlers/items.ts), and [По категориям] into its drill-down (handlers/drill.ts).

// The last row, «📈 Диаграмма», opens the shown period as a pie chart in the Mini App, with each
// category's change against the previous period and the trend of its converted totals under it.
function summaryView(summary: PeriodSummary, chartUrl: string | undefined): ScreenView {
  const row = [
    InlineKeyboard.text(messages.periodPrev(summary.previous), summaryPageData(summary.previous)),
    ...(summary.next === undefined
      ? []
      : [InlineKeyboard.text(messages.periodNext(summary.next), summaryPageData(summary.next))]),
  ];
  // [По категориям] opens the drill-down's category picker (handlers/drill.ts); a period with no
  // expenses has nothing to pick.
  const drill =
    summary.currencies.length === 0
      ? []
      : [InlineKeyboard.text(messages.drillButton, drillPickerData(summary.period, 1))];
  return {
    text: messages.periodSummary(summary),
    markup: InlineKeyboard.from([
      row,
      [
        ...drill,
        InlineKeyboard.text(messages.periodItemsButton, periodItemsData(summary.period, 1)),
      ],
      ...(chartUrl === undefined ? [] : [[InlineKeyboard.webApp(messages.chartButton, chartUrl)]]),
    ]),
  };
}

// The chart button's URL: WEBAPP_URL with the period's chart payload in the fragment's `z`
// (ADR-0025, ADR-0045), rebuilt on every render, the trend ending at the shown period and each
// line compared with the previous period (periodChart). Undefined outside a private chat
// (`web_app` buttons work only there), without WEBAPP_URL, when the first block isn't in the
// ledger's currency (then nothing converted, so there's no pie, as with no expenses at all), and
// when the payload can't fit its budget.
function chartUrlOf(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  summary: PeriodSummary,
): string | undefined {
  if (ctx.chat?.type !== 'private' || deps.webappUrl === undefined) return undefined;
  const [converted, ...unconverted] = summary.currencies;
  if (converted?.currency !== summary.ledger.defaultCurrency) return undefined;
  const chart = periodChart(deps, {
    user,
    ledgerId: summary.ledger.id,
    period: summary.period,
    now: deps.now(),
  });
  const payload = encodeChartPayload(
    messages.chart({
      period: summary.period,
      converted,
      approximate: summary.convertedFrom.length > 0,
      unconverted,
      trend: chart?.trend ?? [],
      comparison: chart?.comparison,
    }),
    messages.chartFold(converted.currency),
  );
  return payload === undefined ? undefined : `${deps.webappUrl}#z=${payload}`;
}

// Shared by /week, /month and their menu labels.
export async function sendSummary(
  ctx: Context,
  deps: HandlerDeps,
  kind: Period['kind'],
): Promise<void> {
  if (ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  const summary = currentPeriodSummary(deps, { user, kind, now });
  if (isLocked(summary)) {
    await replyHtml(ctx, messages.ledgerLocked);
    return;
  }
  const screen: SummaryScreen = { name: 'summary', ledgerId: summary.ledger.id };
  await showScreen(
    ctx,
    deps,
    user,
    screen,
    summaryView(summary, chartUrlOf(ctx, deps, user, summary)),
  );
  if (kind === 'month') await offerTip(ctx, deps, user, 'monthShown');
}

export function registerSummary(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('week', (ctx) => sendSummary(ctx, deps, 'week'));
  bot.command('month', (ctx) => sendSummary(ctx, deps, 'month'));

  bot.callbackQuery(SUMMARY_PAGE, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const { screen } = tap.anchor;
    if (screen.name !== 'summary') {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const kind = ctx.match[1] === 'm' ? 'month' : 'week';
    const period = parsePeriod(kind, ctx.match[2] ?? '');
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
    // A forged or future period is answered silently and edits nothing.
    await ctx.answerCallbackQuery();
    if (summary !== undefined) {
      await renderAnchor(
        ctx,
        tap.anchor,
        summaryView(summary, chartUrlOf(ctx, deps, tap.user, summary)),
      );
      // The picker's [« Назад] lands here: the digest leaves the drill-down.
      if (screen.drill !== undefined) {
        setAnchor(deps, tap.user, {
          ...tap.anchor,
          screen: { name: 'summary', ledgerId: screen.ledgerId },
        });
      }
    }
  });
}
