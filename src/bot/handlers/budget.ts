import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { BudgetScope } from '../../db/budgets.js';
import type { CategoryId } from '../../db/categories.js';
import type { User } from '../../db/users.js';
import { encodePacePayload } from '../../domain/chartPayload.js';
import type { CurrencyCode } from '../../domain/currencies.js';
import {
  activeLedgerId,
  budgetPace,
  budgetScreen,
  clearCap,
  setScope,
  startBudgetFlow,
  type BudgetAnswerResult,
  type BudgetScreenView,
} from '../../services/budget.js';
import {
  cancelFlowIf,
  setAnchor,
  type BudgetFlow,
  type BudgetScreen,
} from '../../services/flowSessions.js';
import { isLocked } from '../../services/ledgerKeys.js';
import {
  ledgerCategories,
  setEssential,
  type CategoriesView,
} from '../../services/manageCategories.js';
import type { HandlerDeps } from '../bot.js';
import {
  BUDGET_CAP,
  BUDGET_CAP_CLEAR,
  BUDGET_CAPS,
  BUDGET_CAPS_OPEN,
  BUDGET_LIMIT,
  BUDGET_OPEN,
  BUDGET_SCOPE,
  BUDGET_SETUP,
  BUDGET_START_DAY,
  BUDGET_WHAT,
  CATEGORY_ESSENTIAL_OPEN,
  CATEGORY_ESSENTIAL_PAGE,
  SET_CATEGORY_ESSENTIAL,
  SETTINGS_OPEN,
  budgetCapClearData,
  budgetCapData,
  budgetCapsPageData,
  budgetScopeData,
  categoryEssentialPageData,
  setCategoryEssentialData,
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

// The /budget screen (ADR-0011, ADR-0017, ADR-0050): the ledger's limit and what's left, its
// setup one tap further behind [Настроить]. The limit, the period start day and the caps are
// asked through text flows (ADR-0009); flows.ts takes the answers.

// The read view: the figures with «📈 Диаграмма» (when there is a chart URL) and [Настроить], or
// only [Задать лимит] while neither a limit nor a cap is set. Opened from a settings hub, it ends
// with [« Назад] to it.
function readView(
  view: BudgetScreenView,
  screen: BudgetScreen,
  chartUrl: string | undefined,
  header?: Html,
): ScreenView {
  const body = messages.budgetScreen(view);
  const { status } = view;
  const unset = status === undefined || (status.limit === undefined && status.caps.length === 0);
  return {
    text: header === undefined ? body : joinHtml([header, body], '\n\n'),
    markup: InlineKeyboard.from([
      ...(unset
        ? [[InlineKeyboard.text(messages.budgetLimitButton, BUDGET_LIMIT)]]
        : [
            ...(chartUrl === undefined
              ? []
              : [[InlineKeyboard.webApp(messages.chartButton, chartUrl)]]),
            [InlineKeyboard.text(messages.budgetSetupButton, BUDGET_SETUP)],
          ]),
      ...(screen.fromSettings === true ? [backRow(SETTINGS_OPEN)] : []),
    ]),
  };
}

// Настроить: what is set, a button per setting, then [« Назад] to the read view.
function setupView(view: BudgetScreenView, header?: Html): ScreenView {
  const budget = view.status?.budget;
  const body = messages.budgetSetupScreen({
    ledger: view.ledger,
    limit:
      budget === undefined || budget.limitMinor === null
        ? undefined
        : { amountMinor: budget.limitMinor, currency: budget.currency },
    startDay: budget?.periodStartDay ?? 1,
    scope: view.status?.scope ?? 'all',
  });
  return {
    text: header === undefined ? body : joinHtml([header, body], '\n\n'),
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.budgetLimitSetupButton, BUDGET_LIMIT)],
      [InlineKeyboard.text(messages.budgetStartDayButton, BUDGET_START_DAY)],
      [InlineKeyboard.text(messages.budgetScopeSetupButton, BUDGET_WHAT)],
      [InlineKeyboard.text(messages.budgetCapsButton, BUDGET_CAPS_OPEN)],
      backRow(BUDGET_OPEN),
    ]),
  };
}

// Что считать: the two scopes, the current one marked, the essential-category picker, then
// [« Назад] to Настроить.
function scopeView(view: BudgetScreenView): ScreenView {
  const current = view.status?.scope ?? 'all';
  const scopeButton = (scope: BudgetScope) => {
    const label = messages.budgetScopeButton(scope);
    return InlineKeyboard.text(
      scope === current ? messages.currentChoice(label) : label,
      budgetScopeData(scope),
    );
  };
  return {
    text: messages.budgetScopeScreen,
    markup: InlineKeyboard.from([
      [scopeButton('all'), scopeButton('optional')],
      [InlineKeyboard.text(messages.essentialCategoriesButton, CATEGORY_ESSENTIAL_OPEN)],
      backRow(BUDGET_SETUP),
    ]),
  };
}

// Every active category of the budget's ledger, each button marked by its current value and
// carrying the opposite one, then [« Назад] to Что считать.
function essentialPickerView(view: CategoriesView, page: number): ScreenView {
  const shown = pageOf(view.categories, page);
  return {
    text: messages.essentialPicker,
    markup: pickerKeyboard(
      shown.items.map((c) =>
        InlineKeyboard.text(
          messages.essentialChoice(c.name, c.essential),
          setCategoryEssentialData(c.id, !c.essential),
        ),
      ),
      pagerRow(shown, categoryEssentialPageData),
      BUDGET_WHAT,
    ),
  };
}

// The chart button's URL: WEBAPP_URL with the budget period's burn-down in the fragment's `z`
// (ADR-0025, ADR-0045), rebuilt on every render. Undefined outside a private chat (`web_app`
// buttons work only there), without WEBAPP_URL, for a budget with no limit, and when the payload
// can't fit its budget. A locked sealed ledger never gets here: its screen is the locked line.
function chartUrlOf(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  view: BudgetScreenView,
): string | undefined {
  if (ctx.chat?.type !== 'private' || deps.webappUrl === undefined) return undefined;
  if (view.status?.limit === undefined) return undefined;
  const pace = budgetPace(deps, { user, ledger: view.ledger, now: deps.now() });
  if (pace === undefined) return undefined;
  const { status, points } = pace;
  const chart = messages.budgetChart({
    currency: status.currency,
    period: status.period,
    limit: status.limit,
    points,
  });
  const payload = encodePacePayload(chart.title, chart.pace);
  return payload === undefined ? undefined : `${deps.webappUrl}#z=${payload}`;
}

// The screen for the ledger an anchor names, as its pane shows it; undefined once the user no
// longer owns it, and the locked message alone while its sealed ledger is locked (ADR-0020).
// `droppedCapsCurrency` puts the line about deleted category caps above it.
export function budgetView(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  screen: BudgetScreen,
  droppedCapsCurrency?: CurrencyCode,
): ScreenView | undefined {
  const view = budgetScreen(deps, { user, ledgerId: screen.ledgerId, now: deps.now() });
  if (view === undefined) return undefined;
  if (isLocked(view)) {
    return {
      text: messages.ledgerLocked,
      markup: InlineKeyboard.from(screen.fromSettings === true ? [backRow(SETTINGS_OPEN)] : []),
    };
  }
  const header =
    droppedCapsCurrency === undefined ? undefined : messages.budgetCapsDropped(droppedCapsCurrency);
  switch (screen.pane) {
    case 'setup':
      return setupView(view, header);
    case 'scope':
      return scopeView(view);
    case 'essential': {
      const categories = ledgerCategories(deps, { user, ledgerId: screen.ledgerId });
      return categories === undefined ? undefined : essentialPickerView(categories, 1);
    }
    case undefined:
      return readView(view, screen, chartUrlOf(ctx, deps, user, view), header);
  }
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
      BUDGET_SETUP,
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
  const view = budgetView(ctx, deps, user, screen);
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
// owns, is stale. One on a sealed ledger that is locked gets the locked toast.
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
  if (isLocked(view)) {
    await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
    return undefined;
  }
  return { ...tap, screen, view };
}

// Stores `pane` on the tap's anchor, so a prompt, a cancel and a saved answer come back to it.
function setPane(deps: HandlerDeps, tap: BudgetTap, pane: BudgetScreen['pane']): void {
  const { ledgerId, fromSettings } = tap.screen;
  const screen: BudgetScreen = {
    name: 'budget',
    ledgerId,
    ...(fromSettings === true ? { fromSettings } : {}),
    ...(pane === undefined ? {} : { pane }),
  };
  setAnchor(deps, tap.user, { ...tap.anchor, screen });
}

// Moves the anchor to `pane` and returns its view, read after any change the tap made.
function showPane(
  ctx: Context,
  deps: HandlerDeps,
  tap: BudgetTap,
  pane: 'setup' | 'scope' | undefined,
): ScreenView {
  setPane(deps, tap, pane);
  const read = budgetScreen(deps, {
    user: tap.user,
    ledgerId: tap.screen.ledgerId,
    now: deps.now(),
  });
  const view = read === undefined || isLocked(read) ? tap.view : read;
  if (pane === 'setup') return setupView(view);
  if (pane === 'scope') return scopeView(view);
  return readView(view, tap.screen, chartUrlOf(ctx, deps, tap.user, view));
}

export function registerBudget(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('budget', (ctx) => sendBudget(ctx, deps));

  // The read view, Настроить and Что считать: each a pane of the same anchor.
  const panes = [
    [BUDGET_OPEN, undefined],
    [BUDGET_SETUP, 'setup'],
    [BUDGET_WHAT, 'scope'],
  ] as const;
  for (const [data, pane] of panes) {
    bot.callbackQuery(data, async (ctx) => {
      const tap = await budgetTap(ctx, deps);
      if (tap === undefined) return;
      const view = showPane(ctx, deps, tap, pane);
      await ctx.answerCallbackQuery();
      await renderAnchor(ctx, tap.anchor, view);
    });
  }

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
        await renderAnchor(ctx, tap.anchor, showPane(ctx, deps, tap, 'scope'));
        return;
      }
    }
  });

  // The essential-category picker under Что считать, on the budget's ledger.
  bot.callbackQuery(CATEGORY_ESSENTIAL_PAGE, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    const view = ledgerCategories(deps, { user: tap.user, ledgerId: tap.screen.ledgerId });
    if (view === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    setPane(deps, tap, 'essential');
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, essentialPickerView(view, Number(ctx.match[1] ?? 1)));
  });

  // The value is in the data: a second tap of the same button finds it set and edits nothing.
  bot.callbackQuery(SET_CATEGORY_ESSENTIAL, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    const { ledgerId } = tap.screen;
    const categoryId = Number(ctx.match[1]) as CategoryId;
    const essential = ctx.match[2] === '1';
    const result = setEssential(deps, { user: tap.user, ledgerId, categoryId, essential });
    switch (result.kind) {
      case 'notFound':
        await ctx.answerCallbackQuery({ text: messages.categoryGoneToast });
        return;
      case 'unchanged':
        await ctx.answerCallbackQuery({ text: messages.essentialUnchanged });
        return;
      case 'set': {
        await ctx.answerCallbackQuery({ text: messages.essentialSetToast(essential) });
        const view = ledgerCategories(deps, { user: tap.user, ledgerId });
        if (view === undefined) return;
        setPane(deps, tap, 'essential');
        const index = view.categories.findIndex((c) => c.id === categoryId);
        const page = Math.floor(Math.max(index, 0) / PAGE_SIZE) + 1;
        await renderAnchor(ctx, tap.anchor, essentialPickerView(view, page));
        return;
      }
    }
  });

  // The cap list, under Настроить, also reached by [« Назад] on a cap prompt: that prompt's flow
  // is cancelled.
  bot.callbackQuery(BUDGET_CAPS, async (ctx) => {
    const tap = await budgetTap(ctx, deps);
    if (tap === undefined) return;
    cancelFlowIf(deps, tap.user, (flow) => flow.kind === 'budgetCap');
    setPane(deps, tap, 'setup');
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
        if (view === undefined || isLocked(view)) return;
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
