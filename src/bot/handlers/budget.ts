import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { BudgetScope } from '../../db/budgets.js';
import type { User } from '../../db/users.js';
import {
  activeLedgerId,
  budgetScreen,
  setScope,
  startBudgetFlow,
  type BudgetAnswerResult,
  type BudgetScreenView,
} from '../../services/budget.js';
import type { BudgetFlow, BudgetScreen } from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import {
  BUDGET_LIMIT,
  BUDGET_OPEN,
  BUDGET_SCOPE,
  BUDGET_START_DAY,
  budgetScopeData,
} from '../callbackData.js';
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
// The limit and the period start day are asked through text flows (ADR-0009); flows.ts takes
// the answers.

function screenView(view: BudgetScreenView): ScreenView {
  const current = view.status?.scope ?? 'all';
  const scopeButton = (scope: BudgetScope) => {
    const label = messages.budgetScopeButton(scope);
    return InlineKeyboard.text(
      scope === current ? messages.currentChoice(label) : label,
      budgetScopeData(scope),
    );
  };
  return {
    text: messages.budgetScreen(view),
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.budgetLimitButton, BUDGET_LIMIT)],
      [InlineKeyboard.text(messages.budgetStartDayButton, BUDGET_START_DAY)],
      [scopeButton('all'), scopeButton('optional')],
    ]),
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

// A flow's prompt in the anchor, naming the value in effect, with a refusal line above it when
// an answer failed.
export function budgetPromptView(
  flow: BudgetFlow,
  view: BudgetScreenView,
  refusal?: Html,
): ScreenView {
  const budget = view.status?.budget;
  let prompt: Html;
  switch (flow.kind) {
    case 'budgetLimit': {
      const current =
        budget?.limitMinor === undefined || budget.limitMinor === null
          ? undefined
          : { amountMinor: budget.limitMinor, currency: budget.currency };
      prompt = messages.budgetLimitPrompt({ currency: view.ledger.defaultCurrency, current });
      break;
    }
    case 'budgetStartDay':
      prompt = messages.budgetStartDayPrompt(budget?.periodStartDay ?? 1);
      break;
  }
  return {
    text: refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The refusal line for an invalid answer to `flow`.
export function budgetRefusal(
  flow: BudgetFlow,
  result: Extract<BudgetAnswerResult, { kind: 'invalid' }>,
): Html {
  switch (result.reason) {
    case 'ambiguousAmount':
      return messages.budgetRefused.ambiguousAmount(
        result.readings.map((r) => ({
          amountMinor: r.amountMinor,
          currency: result.ledger.defaultCurrency,
        })),
      );
    case 'expenseShaped':
      return messages.budgetRefused.expenseShaped[flow.kind];
    default:
      return messages.budgetRefused[result.reason];
  }
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

  bot.callbackQuery(BUDGET_SCOPE, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    const scope: BudgetScope = ctx.match[1] === 'o' ? 'optional' : 'all';
    const now = deps.now();
    const result = setScope(deps, { user: tap.user, ledgerId: tap.screen.ledgerId, scope, now });
    switch (result.kind) {
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.staleScreen });
        return;
      case 'unchanged':
        await ctx.answerCallbackQuery({ text: messages.budgetScopeUnchanged });
        return;
      case 'set': {
        await ctx.answerCallbackQuery({ text: messages.budgetScopeChangedToast });
        const view = budgetView(deps, tap.user, tap.screen);
        if (view !== undefined) await renderAnchor(ctx, tap.anchor, view);
        return;
      }
    }
  });

  // [Задать лимит] and [День начала периода] each ask through their own flow.
  const prompts = [
    [BUDGET_LIMIT, 'budgetLimit'],
    [BUDGET_START_DAY, 'budgetStartDay'],
  ] as const;
  for (const [data, kind] of prompts) {
    bot.callbackQuery(data, async (ctx) => {
      const tap = await budgetTap(ctx, deps);
      if (tap === undefined) return;
      const flow: BudgetFlow = { kind, ledgerId: tap.screen.ledgerId };
      if (!startBudgetFlow(deps, { user: tap.user, flow, now: deps.now() })) {
        await ctx.answerCallbackQuery({ text: messages.staleScreen });
        return;
      }
      await ctx.answerCallbackQuery();
      await renderAnchor(ctx, tap.anchor, budgetPromptView(flow, tap.view));
    });
  }
}
