import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { BudgetScope } from '../../db/budgets.js';
import type { CategoryId } from '../../db/categories.js';
import type { User } from '../../db/users.js';
import type { CurrencyCode } from '../../domain/currencies.js';
import {
  activeLedgerId,
  budgetScreen,
  clearCap,
  setScope,
  startBudgetFlow,
  type BudgetAnswerResult,
  type BudgetScreenView,
} from '../../services/budget.js';
import { cancelFlowIf, type BudgetFlow, type BudgetScreen } from '../../services/flowSessions.js';
import type { HandlerDeps } from '../bot.js';
import {
  BUDGET_CAP,
  BUDGET_CAP_CLEAR,
  BUDGET_CAPS,
  BUDGET_CAPS_OPEN,
  BUDGET_LIMIT,
  BUDGET_OPEN,
  BUDGET_SCOPE,
  BUDGET_START_DAY,
  SETTINGS_OPEN,
  budgetCapClearData,
  budgetCapData,
  budgetCapsPageData,
  budgetScopeData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { PAGE_SIZE, pageOf, pagerRow, pickerKeyboard } from '../nav.js';
import { joinHtml, replyHtml, type Html } from '../render/html.js';
import {
  backRow,
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

// Opened from a settings hub, the screen ends with [« Назад] to it.
function screenView(view: BudgetScreenView, screen: BudgetScreen, header?: Html): ScreenView {
  const body = messages.budgetScreen(view);
  const current = view.status?.scope ?? 'all';
  const scopeButton = (scope: BudgetScope) => {
    const label = messages.budgetScopeButton(scope);
    return InlineKeyboard.text(
      scope === current ? messages.currentChoice(label) : label,
      budgetScopeData(scope),
    );
  };
  return {
    text: header === undefined ? body : joinHtml([header, body], '\n\n'),
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.budgetLimitButton, BUDGET_LIMIT)],
      [InlineKeyboard.text(messages.budgetStartDayButton, BUDGET_START_DAY)],
      [scopeButton('all'), scopeButton('optional')],
      [InlineKeyboard.text(messages.budgetCapsButton, BUDGET_CAPS_OPEN)],
      ...(screen.fromSettings === true ? [backRow(SETTINGS_OPEN)] : []),
    ]),
  };
}

// The screen for the ledger an anchor names; undefined once the user no longer owns it.
// `droppedCapsCurrency` puts the line about deleted category caps above it.
export function budgetView(
  deps: HandlerDeps,
  user: User,
  screen: BudgetScreen,
  droppedCapsCurrency?: CurrencyCode,
): ScreenView | undefined {
  const view = budgetScreen(deps, { user, ledgerId: screen.ledgerId, now: deps.now() });
  if (view === undefined) return undefined;
  return screenView(
    view,
    screen,
    droppedCapsCurrency === undefined ? undefined : messages.budgetCapsDropped(droppedCapsCurrency),
  );
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
    case 'budgetCap': {
      const category = view.categories.find((c) => c.id === flow.categoryId);
      const currency = budget?.currency ?? view.ledger.defaultCurrency;
      const capMinor = category?.capMinor ?? null;
      prompt = messages.budgetCapPrompt({
        name: category?.name ?? '',
        currency,
        current: capMinor === null ? undefined : { amountMinor: capMinor, currency },
      });
      // A capped category's prompt offers [Убрать лимит], then [« Назад] to the cap list's
      // first page above [Отмена].
      return {
        text: refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n'),
        markup: InlineKeyboard.from([
          ...(capMinor === null
            ? []
            : [
                [
                  InlineKeyboard.text(
                    messages.budgetCapClearButton,
                    budgetCapClearData(flow.categoryId),
                  ),
                ],
              ]),
          backRow(BUDGET_CAPS_OPEN),
          cancelRow(),
        ]),
      };
    }
  }
  return {
    text: refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The paged category list: each category labelled with its cap, then the pager and [« Назад].
function capsPickerView(view: BudgetScreenView, page: number): ScreenView {
  const currency = view.status?.currency ?? view.ledger.defaultCurrency;
  const shown = pageOf(view.categories, page);
  return {
    text: messages.budgetCapsPicker,
    markup: pickerKeyboard(
      shown.items.map((c) =>
        InlineKeyboard.text(
          messages.capChoice(
            c.name,
            c.capMinor === null ? null : { amountMinor: c.capMinor, currency },
          ),
          budgetCapData(c.id),
        ),
      ),
      pagerRow(shown, budgetCapsPageData),
      BUDGET_OPEN,
    ),
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
        result.readings.map((r) => ({ amountMinor: r.amountMinor, currency: result.currency })),
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
    await renderAnchor(ctx, tap.anchor, screenView(tap.view, tap.screen));
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

  // The cap list, also reached by [« Назад] on a cap prompt: that prompt's flow is cancelled.
  bot.callbackQuery(BUDGET_CAPS, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    cancelFlowIf(deps, tap.user, (flow) => flow.kind === 'budgetCap');
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, capsPickerView(tap.view, Number(ctx.match[1] ?? 1)));
  });

  bot.callbackQuery(BUDGET_CAP, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    const categoryId = Number(ctx.match[1]) as CategoryId;
    const flow: BudgetFlow = { kind: 'budgetCap', ledgerId: tap.screen.ledgerId, categoryId };
    if (!startBudgetFlow(deps, { user: tap.user, flow, now: deps.now() })) {
      await ctx.answerCallbackQuery({ text: messages.categoryGoneToast });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, budgetPromptView(flow, tap.view));
  });

  // Absolute: a second tap finds no cap and edits nothing.
  bot.callbackQuery(BUDGET_CAP_CLEAR, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    const categoryId = Number(ctx.match[1]) as CategoryId;
    const { ledgerId } = tap.screen;
    const result = clearCap(deps, { user: tap.user, ledgerId, categoryId });
    switch (result.kind) {
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.staleScreen });
        return;
      case 'unchanged':
        await ctx.answerCallbackQuery({ text: messages.capUnchanged });
        return;
      case 'cleared': {
        await ctx.answerCallbackQuery({ text: messages.capClearedToast });
        const view = budgetScreen(deps, { user: tap.user, ledgerId, now: deps.now() });
        if (view === undefined) return;
        const index = view.categories.findIndex((c) => c.id === categoryId);
        const page = Math.floor(Math.max(index, 0) / PAGE_SIZE) + 1;
        await renderAnchor(ctx, tap.anchor, capsPickerView(view, page));
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
