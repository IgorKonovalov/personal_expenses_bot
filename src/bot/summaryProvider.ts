import { GrammyError, InlineKeyboard, type Api, type Composer, type Context } from 'grammy';
import type { Provider } from '../scheduler/types.js';
import { isLocked } from '../services/ledgerKeys.js';
import {
  claimSummary,
  dueSummaries,
  periodReport,
  turnSummaryPushOff,
  type DueSummary,
} from '../services/periodReport.js';
import type { HandlerDeps } from './bot.js';
import { SUMMARY_PUSH_OFF, summaryPushOffData } from './callbackData.js';
import { ensureUser } from './handlers/start.js';
import { messages } from './messages.js';
import { sendHtml } from './render/html.js';
import type { ScreenView } from './screens.js';

// The scheduler's provider for the summary pushes (ADR-0031). The service claims each push
// before it is sent; a failed send is logged and not retried.

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
  if (isLocked(report)) throw new Error(`ledger ${due.ledger.id} is locked`);
  return {
    text:
      due.push === 'weekly'
        ? messages.weeklySummaryPush(report)
        : messages.periodSummaryPush(report),
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.pushOffButton, summaryPushOffData(due.push))],
    ]),
  };
}

// [Отключить] under a push: that push off, the toast says how to switch it back on, and the
// keyboard leaves the message. A repeat tap finds the push off and the button gone already.
export function registerSummaryPush(bot: Composer<Context>, deps: HandlerDeps): void {
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
}
