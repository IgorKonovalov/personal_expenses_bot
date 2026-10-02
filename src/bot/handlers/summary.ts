import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { parsePeriod, type Period } from '../../domain/periods.js';
import type { SummaryScreen } from '../../services/flowSessions.js';
import { isLocked } from '../../services/ledgerKeys.js';
import {
  currentPeriodSummary,
  ledgerPeriodSummary,
  type PeriodSummary,
} from '../../services/periodSummary.js';
import type { HandlerDeps } from '../bot.js';
import { SUMMARY_PAGE, summaryPageData } from '../callbackData.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { renderAnchor, requireScreen, showScreen, type ScreenView } from '../screens.js';
import { ensureUser } from './start.js';

// /week and /month (ADR-0011 screens): a period's totals by currency and category, with a pager
// that names the neighbouring periods and pages in place. Paging reads the ledger the screen
// was opened on.

function summaryView(summary: PeriodSummary): ScreenView {
  const row = [
    InlineKeyboard.text(messages.periodPrev(summary.previous), summaryPageData(summary.previous)),
    ...(summary.next === undefined
      ? []
      : [InlineKeyboard.text(messages.periodNext(summary.next), summaryPageData(summary.next))]),
  ];
  return { text: messages.periodSummary(summary), markup: InlineKeyboard.from([row]) };
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
  await showScreen(ctx, deps, user, screen, summaryView(summary));
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
    if (summary !== undefined) await renderAnchor(ctx, tap.anchor, summaryView(summary));
  });
}
