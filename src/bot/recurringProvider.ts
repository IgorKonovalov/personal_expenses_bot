import { InlineKeyboard, type Api } from 'grammy';
import { localDateOf } from '../domain/time.js';
import type { Provider } from '../scheduler/types.js';
import { effectiveTimezone } from '../services/recordExpense.js';
import {
  dueRules,
  fireRule,
  type DueRule,
  type Fired,
  type FireResult,
} from '../services/recurring.js';
import type { HandlerDeps } from './bot.js';
import { undoExpenseData } from './callbackData.js';
import { messages } from './messages.js';
import { sendHtml } from './render/html.js';

// The scheduler's provider for recurring rules (ADR-0031). The service records each due
// occurrence and commits; the notices are sent afterwards. A failed send is logged and not
// retried: the expense stays recorded and shows in /today.

export function recurringProvider(deps: HandlerDeps, api: Api): Provider<DueRule> {
  return {
    name: 'recurring',
    due: (now) => dueRules(deps, now),
    fire: async (due, now) => {
      const result = fireRule(deps, due, now);
      if (result === undefined) return;
      for (const fired of result.fired) await notify(deps, api, result, fired, now);
    },
  };
}

async function notify(
  deps: HandlerDeps,
  api: Api,
  result: FireResult,
  fired: Fired,
  now: Date,
): Promise<void> {
  const { expense, ledger } = fired;
  const sentOn = localDateOf(now, effectiveTimezone(deps, result.author.user, ledger));
  try {
    await sendHtml(
      api,
      result.author.telegramId,
      messages.recurringRecorded({ expense, ledger, sentOn }),
      {
        reply_markup: new InlineKeyboard().text(messages.undoButton, undoExpenseData(expense.id)),
      },
    );
  } catch (error) {
    deps.logger.warn(
      {
        ruleId: result.rule.id,
        expenseId: expense.id,
        err: error instanceof Error ? error.name : typeof error,
      },
      'recurring notice failed',
    );
  }
}
