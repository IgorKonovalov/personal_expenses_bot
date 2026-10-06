import { GrammyError, InlineKeyboard, type Api, type Composer, type Context } from 'grammy';
import type { PushKind } from '../db/users.js';
import type { Provider } from '../scheduler/types.js';
import { isLocked } from '../services/ledgerKeys.js';
import {
  claimSummary,
  dueSummaries,
  periodReport,
  shownSummary,
  turnSummaryPushOff,
  type DueSummary,
  type PeriodReport,
} from '../services/periodReport.js';
import type { HandlerDeps } from './bot.js';
import {
  SUMMARY_PUSH_OFF,
  SUMMARY_PUSH_SHOW,
  summaryPushOffData,
  summaryPushShowData,
} from './callbackData.js';
import { ensureUser } from './handlers/start.js';
import { messages } from './messages.js';
import { editHtml, sendHtml } from './render/html.js';
import type { ScreenView } from './screens.js';

// The scheduler's provider for the summary pushes (ADR-0031). The service claims each push
// before it is sent; a failed send is logged and not retried. A sealed ledger that is locked
// gets a push with no figures and [Показать], which renders the report in place once unlocked.

export function summaryProvider(deps: HandlerDeps, api: Api): Provider<DueSummary> {
  return {
    name: 'summary',
    due: (now) => dueSummaries(deps, now),
    fire: async (due, now) => {
      if (claimSummary(deps, due, now) !== 'sent') return;
      const view = pushView(deps, due);
      try {
        await sendHtml(api, due.recipient.telegramId, view.text, { reply_markup: view.markup });
      } catch (error) {
        deps.logger.warn(
          {
            ledgerId: due.ledger.id,
            kind: due.kind,
            periodKey: due.periodKey,
            err: error instanceof Error ? error.name : typeof error,
          },
          'summary push failed',
        );
      }
    },
  };
}

function pushView(deps: HandlerDeps, due: DueSummary): ScreenView {
  const report = periodReport(deps, {
    ledger: due.ledger,
    readerId: due.recipient.user.id,
    period: due.period,
    previous: due.previous,
  });
  if (!isLocked(report)) return reportView(due.push, report);
  return {
    text: messages.summaryLocked(due.period),
    markup: InlineKeyboard.from([
      [
        InlineKeyboard.text(messages.pushShowButton, summaryPushShowData(due.push, due.periodKey)),
        InlineKeyboard.text(messages.pushOffButton, summaryPushOffData(due.push)),
      ],
    ]),
  };
}

function reportView(push: PushKind, report: PeriodReport): ScreenView {
  return {
    text:
      push === 'weekly' ? messages.weeklySummaryPush(report) : messages.periodSummaryPush(report),
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.pushOffButton, summaryPushOffData(push))],
    ]),
  };
}

export function registerSummaryPush(bot: Composer<Context>, deps: HandlerDeps): void {
  // [Отключить] under a push: that push off, the toast says how to switch it back on, and the
  // keyboard leaves the message. A repeat tap finds the push off and the button gone already.
  bot.callbackQuery(SUMMARY_PUSH_OFF, async (ctx) => {
    const push = ctx.match[1] === 'w' ? 'weekly' : 'monthly';
    turnSummaryPushOff(deps, ensureUser(deps, ctx.from.id, deps.now()), push);
    await ctx.answerCallbackQuery({ text: messages.pushOff(push) });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes('message is not modified')) {
        return;
      }
      throw error;
    }
  });

  // [Показать] under a locked ledger's push: the full report in place while unlocked, else the
  // locked toast. A key no sent push carries is answered silently and edits nothing.
  bot.callbackQuery(SUMMARY_PUSH_SHOW, async (ctx) => {
    const push = ctx.match[1] === 'w' ? 'weekly' : 'monthly';
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const report = shownSummary(deps, { user, push, periodKey: ctx.match[2] ?? '' });
    if (isLocked(report)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    await ctx.answerCallbackQuery();
    if (report === undefined) return;
    const view = reportView(push, report);
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });
}
