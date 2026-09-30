import type { Context, MiddlewareFn } from 'grammy';
import type { User } from '../db/users.js';
import {
  cancelFlow,
  currentAnchor,
  type Flow,
  type ScreenAnchor,
} from '../services/flowSessions.js';
import { answerCategoryFlow } from '../services/manageCategories.js';
import type { HandlerDeps } from './bot.js';
import { categoriesScreenFor, promptView } from './handlers/categories.js';
import { ensureUser } from './handlers/start.js';
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
  const view = categoriesScreenFor(deps, user, anchor.screen.ledgerId);
  if (view !== undefined) await renderAnchor(ctx, anchor, view);
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
  const result = answerCategoryFlow(deps, { ...input, now: deps.now() });
  const anchor = currentAnchor(deps, user);

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
      const view = categoriesScreenFor(deps, user, flow.ledgerId, header);
      if (view !== undefined) await show(ctx, anchor, view);
      return;
    }
  }
}
