import type { Context, MiddlewareFn } from 'grammy';
import type { User } from '../db/users.js';
import { answerBudgetFlow, budgetScreen } from '../services/budget.js';
import { showExpense } from '../services/changeCategory.js';
import { answerEditFlow } from '../services/editExpense.js';
import {
  cancelFlow,
  currentAnchor,
  isBudgetFlow,
  isEditFlow,
  isSecretFlow,
  type BudgetScreen,
  type CategoriesScreen,
  type EditFlow,
  type Flow,
  type ScreenAnchor,
} from '../services/flowSessions.js';
import { answerCategoryFlow } from '../services/manageCategories.js';
import { answerTimezoneFlow, screenSettings } from '../services/settings.js';
import type { HandlerDeps } from './bot.js';
import { budgetPromptView, budgetRefusal, budgetView } from './handlers/budget.js';
import { cardFor, cardView, recordedCard } from './handlers/card.js';
import { categoriesScreenFor, promptView } from './handlers/categories.js';
import { editPromptView } from './handlers/edit.js';
import { settingsView, timezonePromptView } from './handlers/settings.js';
import { ensureUser } from './handlers/start.js';
import { answerSecretFlow } from './handlers/unlock.js';
import { messages } from './messages.js';
import { replyHtml } from './render/html.js';
import { renderAnchor, type ScreenView } from './screens.js';

// Text flows (ADR-0009): the answer to a pending prompt, and what clears one.

function isCommand(ctx: Context, name?: string): boolean {
  const message = ctx.message;
  const startsWithCommand = (message?.entities ?? []).some(
    (entity) => entity.type === 'bot_command' && entity.offset === 0,
  );
  if (!startsWithCommand || message?.text === undefined) return false;
  if (name === undefined) return true;
  const [command] = message.text.slice(1).split(/[\s@]/);
  return command === name;
}

// Any command but /cancel, and any menu tap, clears the pending flow before its own handler
// runs. /cancel clears it itself, because it also restores the anchor. Register before every
// command and menu handler.
export function clearFlowOnCommand(deps: HandlerDeps): MiddlewareFn {
  const menuLabels = new Set<string>(Object.values(messages.menu));
  return async (ctx, next) => {
    const text = ctx.message?.text;
    if (
      ctx.from !== undefined &&
      text !== undefined &&
      ((isCommand(ctx) && !isCommand(ctx, 'cancel')) || menuLabels.has(text))
    ) {
      cancelFlow(deps, ensureUser(deps, ctx.from.id, deps.now()));
    }
    await next();
  };
}

async function show(ctx: Context, anchor: ScreenAnchor | undefined, view: ScreenView) {
  if (anchor === undefined) {
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
    return;
  }
  await renderAnchor(ctx, anchor, view);
}

// The screen the anchor shows, re-rendered: after a cancel, or when a flow's target is gone.
export async function restoreScreen(ctx: Context, deps: HandlerDeps, user: User): Promise<void> {
  const anchor = currentAnchor(deps, user);
  if (anchor === undefined) return;
  const { screen } = anchor;
  // A summary starts no flow, so a cancel never has one to restore.
  if (screen.name === 'summary') return;
  if (screen.name === 'expense') {
    // The card for the expense's stored state, as it was before the prompt.
    const shown = showExpense(deps, { user, expenseId: screen.expenseId });
    if (shown.kind === 'card')
      await renderAnchor(ctx, anchor, cardFor(cardView(deps, user, shown)));
    return;
  }
  const view =
    screen.name === 'settings'
      ? settingsView(deps, user, screen.ledgerId)
      : screen.name === 'budget'
        ? budgetView(deps, user, screen)
        : categoriesScreenFor(deps, user, screen);
  if (view !== undefined) await renderAnchor(ctx, anchor, view);
}

// A typed answer to an edit prompt in the card (the anchor). A valid one puts the card back with
// the new value; an invalid one re-asks there. After the expense was deleted mid-flow, the flow
// is cleared and the card shows its deleted form.
async function answerEdit(
  ctx: Context,
  deps: HandlerDeps,
  anchor: ScreenAnchor | undefined,
  input: {
    readonly user: User;
    readonly flow: EditFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const { user, flow } = input;
  const result = answerEditFlow(deps, { ...input, now: deps.now() });
  switch (result.kind) {
    case 'invalid':
      await show(ctx, anchor, editPromptView(flow.kind, result.expense, result.today, result));
      return;
    case 'gone': {
      await replyHtml(ctx, messages.editGone);
      const { expense, ledger } = result;
      if (anchor !== undefined && expense !== undefined && ledger !== undefined) {
        await renderAnchor(ctx, anchor, cardFor(cardView(deps, user, { expense, ledger })));
      }
      return;
    }
    case 'editable':
      await show(ctx, anchor, recordedCard(cardView(deps, user, result)));
      return;
  }
}

// A text taken as the answer to the pending flow. A valid answer completes the flow and puts
// the screen back in the anchor; an invalid one re-asks there and keeps the flow pending.
export async function answerFlow(
  ctx: Context,
  deps: HandlerDeps,
  input: {
    readonly user: User;
    readonly flow: Flow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const { user, flow } = input;
  const anchor = currentAnchor(deps, user);

  if (isSecretFlow(flow)) {
    await answerSecretFlow(ctx, deps, anchor, { ...input, flow });
    return;
  }

  if (isEditFlow(flow)) {
    await answerEdit(ctx, deps, anchor, { ...input, flow });
    return;
  }

  if (isBudgetFlow(flow)) {
    const result = answerBudgetFlow(deps, { ...input, flow, now: deps.now() });
    switch (result.kind) {
      case 'invalid': {
        const view = budgetScreen(deps, { user, ledgerId: flow.ledgerId, now: deps.now() });
        if (view !== undefined)
          await show(ctx, anchor, budgetPromptView(flow, view, budgetRefusal(flow, result)));
        return;
      }
      case 'gone':
        await restoreScreen(ctx, deps, user);
        return;
      case 'set': {
        // The flow's ledger, with the anchor's back route to the settings hub when it has one.
        const fromSettings = anchor?.screen.name === 'budget' && anchor.screen.fromSettings;
        const screen: BudgetScreen =
          fromSettings === true
            ? { name: 'budget', ledgerId: flow.ledgerId, fromSettings }
            : { name: 'budget', ledgerId: flow.ledgerId };
        const view = budgetView(deps, user, screen, result.droppedCapsCurrency);
        if (view !== undefined) await show(ctx, anchor, view);
        return;
      }
    }
  }

  if (flow.kind === 'setTimezone') {
    // The user's own zone, or the shared ledger's when the prompt came from its scoped hub.
    const { ledgerId } = flow;
    const result = answerTimezoneFlow(deps, { ...input, ledgerId });
    switch (result.kind) {
      case 'invalid': {
        const current = screenSettings(deps, user, ledgerId)?.timezone;
        if (current === undefined) return;
        await show(
          ctx,
          anchor,
          timezonePromptView(current, messages.timezoneRefused[result.reason]),
        );
        return;
      }
      case 'forbidden':
        await restoreScreen(ctx, deps, user);
        return;
      case 'updated': {
        const view =
          ledgerId === undefined
            ? settingsView(deps, { ...user, timezone: result.timezone })
            : settingsView(deps, user, ledgerId);
        if (view !== undefined) await show(ctx, anchor, view);
        return;
      }
    }
  }

  const result = answerCategoryFlow(deps, { ...input, flow, now: deps.now() });
  switch (result.kind) {
    case 'invalid':
      await show(
        ctx,
        anchor,
        promptView(flow, result.current?.name, messages.categoryNameRefused[result.reason]),
      );
      return;
    case 'gone':
      await restoreScreen(ctx, deps, user);
      return;
    case 'added':
    case 'restored':
    case 'renamed': {
      const header =
        result.kind === 'added'
          ? messages.categoryAdded(result.category.name)
          : result.kind === 'restored'
            ? messages.categoryRestored(result.category.name)
            : messages.categoryRenamed(result.category.name);
      // The flow's ledger, with the anchor's back route to the settings hub when it has one.
      const fromSettings = anchor?.screen.name === 'categories' && anchor.screen.fromSettings;
      const screen: CategoriesScreen =
        fromSettings === true
          ? { name: 'categories', ledgerId: flow.ledgerId, fromSettings }
          : { name: 'categories', ledgerId: flow.ledgerId };
      const view = categoriesScreenFor(deps, user, screen, header);
      if (view !== undefined) await show(ctx, anchor, view);
      return;
    }
  }
}
