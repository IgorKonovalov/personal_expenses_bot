import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import {
  activeLedgerId,
  budgetScreen,
  startBudgetFlow,
  type BudgetAnswerResult,
  type BudgetScreenView,
} from '../../services/budget.js';
import type { BudgetScreen } from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import { BUDGET_LIMIT, BUDGET_OPEN } from '../callbackData.js';
import { messages } from '../messages.js';
import { joinHtml, replyHtml, type Html } from '../render/html.js';
import {
  cancelRow,
  renderAnchor,
  requireScreen,
  showScreen,
  type ScreenTap,
  type ScreenView,
} from '../screens.js';
import { ensureUser } from './start.js';

// The /budget screen (ADR-0011, ADR-0017): the ledger's limit and what's left, with its setup.
// The limit is asked through a text flow (ADR-0009); flows.ts takes the answer.

function screenView(view: BudgetScreenView): ScreenView {
  return {
    text: messages.budgetScreen(view),
    markup: InlineKeyboard.from([[InlineKeyboard.text(messages.budgetLimitButton, BUDGET_LIMIT)]]),
  };
}

// The screen for the ledger an anchor names; undefined once the user no longer owns it.
export function budgetView(
  deps: HandlerDeps,
  user: User,
  screen: BudgetScreen,
): ScreenView | undefined {
  const view = budgetScreen(deps, { user, ledgerId: screen.ledgerId, now: deps.now() });
  return view === undefined ? undefined : screenView(view);
}

// The limit prompt in the anchor, naming the limit in effect, with a refusal line above it when
// an answer failed.
export function limitPromptView(view: BudgetScreenView, refusal?: Html): ScreenView {
  const budget = view.status?.budget;
  const current =
    budget?.limitMinor === undefined || budget.limitMinor === null
      ? undefined
      : { amountMinor: budget.limitMinor, currency: budget.currency };
  const prompt = messages.budgetLimitPrompt({ currency: view.ledger.defaultCurrency, current });
  return {
    text: refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The refusal line for an invalid limit answer.
export function limitRefusal(result: Extract<BudgetAnswerResult, { kind: 'invalid' }>): Html {
  if (result.reason === 'ambiguousAmount') {
    return messages.budgetLimitRefused.ambiguousAmount(
      result.readings.map((r) => ({
        amountMinor: r.amountMinor,
        currency: result.ledger.defaultCurrency,
      })),
    );
  }
  return messages.budgetLimitRefused[result.reason];
}

export async function sendBudget(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const screen: BudgetScreen = { name: 'budget', ledgerId: activeLedgerId(deps, user) };
  const view = budgetView(deps, user, screen);
  if (view === undefined) {
    await replyHtml(ctx, messages.budgetOwnerOnly);
    return;
  }
  await showScreen(ctx, deps, user, screen, view);
}

interface BudgetTap extends ScreenTap {
  readonly screen: BudgetScreen;
  readonly view: BudgetScreenView;
}

// A budget callback on an anchor that shows another screen, or on a ledger the user no longer
// owns, is stale.
async function budgetTap(ctx: Context, deps: HandlerDeps): Promise<BudgetTap | undefined> {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  const { screen } = tap.anchor;
  const view =
    screen.name === 'budget'
      ? budgetScreen(deps, { user: tap.user, ledgerId: screen.ledgerId, now: deps.now() })
      : undefined;
  if (screen.name !== 'budget' || view === undefined) {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { ...tap, screen, view };
}

export function registerBudget(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('budget', (ctx) => sendBudget(ctx, deps));

  bot.callbackQuery(BUDGET_OPEN, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, screenView(tap.view));
  });

  bot.callbackQuery(BUDGET_LIMIT, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    const flow = { kind: 'budgetLimit', ledgerId: tap.screen.ledgerId } as const;
    if (!startBudgetFlow(deps, { user: tap.user, flow, now: deps.now() })) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, limitPromptView(tap.view));
  });
}
