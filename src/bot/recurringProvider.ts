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
import { REMINDER_EXPENSE } from './callbackData.js';
import { askCard, recurringRecordedCard } from './handlers/recurring.js';
import { messages } from './messages.js';
import { sendHtml, type Html } from './render/html.js';
import type { ScreenView } from './screens.js';

// The scheduler's provider for recurring rules (ADR-0031). The service records or claims each
// due occurrence and commits; the notices are sent afterwards. A failed send is logged and not
// retried: an `auto` expense stays recorded and shows in /today.

export function recurringProvider(deps: HandlerDeps, api: Api): Provider<DueRule> {
  return {
    name: 'recurring',
    due: (now) => dueRules(deps, now),
    fire: async (due, now) => {
      const result = fireRule(deps, due, now);
      if (result === undefined) return;
      const skipped = result.fired.filter((f) => f.kind === 'skipped').length;
      if (skipped > 0) await send(deps, api, result, messages.recurringAskMissed(skipped));
      for (const fired of result.fired) {
        const view = notice(deps, result, fired, now);
        if (view !== undefined) await send(deps, api, result, view.text, view);
      }
    },
  };
}

function notice(
  deps: HandlerDeps,
  result: FireResult,
  fired: Fired,
  now: Date,
): ScreenView | undefined {
  const { user } = result.author;
  switch (fired.kind) {
    case 'recorded':
      return recurringRecordedCard(deps, user, fired, now);
    case 'asked': {
      const { template } = result.rule;
      if (template === null) return undefined;
      const today = localDateOf(now, effectiveTimezone(deps, user, fired.ledger));
      return askCard({ rule: result.rule, template }, fired.dueOn, today);
    }
    case 'reminded':
      return {
        text: messages.reminderDue(fired.text),
        markup: new InlineKeyboard().text(messages.reminderExpenseButton, REMINDER_EXPENSE),
      };
    case 'skipped':
      return undefined;
  }
}

async function send(
  deps: HandlerDeps,
  api: Api,
  result: FireResult,
  text: Html,
  view?: ScreenView,
): Promise<void> {
  try {
    await sendHtml(
      api,
      result.author.telegramId,
      text,
      view === undefined ? {} : { reply_markup: view.markup },
    );
  } catch (error) {
    deps.logger.warn(
      { ruleId: result.rule.id, err: error instanceof Error ? error.name : typeof error },
      'recurring notice failed',
    );
  }
}
