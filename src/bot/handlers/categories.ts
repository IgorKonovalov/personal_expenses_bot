import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { CategoryId } from '../../db/categories.js';
import type { User } from '../../db/users.js';
import type { LedgerId } from '../../db/ledgers.js';
import type { Flow } from '../../services/flowSessions.js';
import {
  activeLedgerCategories,
  archivableCategories,
  hideCategory,
  ledgerCategories,
  startAdd,
  startRename,
  type CategoriesView,
} from '../../services/manageCategories.js';
import type { HandlerDeps } from '../bot.js';
import {
  CATEGORIES_OPEN,
  CATEGORY_ADD,
  CATEGORY_ARCHIVE,
  CATEGORY_ARCHIVE_PAGE,
  CATEGORY_RENAME,
  CATEGORY_RENAME_PAGE,
  categoryActionData,
  categoryActionPageData,
  categoryActionPickData,
  type CategoryAction,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow, pickerKeyboard } from '../nav.js';
import { joinHtml, type Html } from '../render/html.js';
import {
  cancelRow,
  renderAnchor,
  requireScreen,
  showScreen,
  type ScreenTap,
  type ScreenView,
} from '../screens.js';
import { ensureUser } from './start.js';

// The /categories screen (ADR-0011): the ledger's active categories, with add, rename and hide.
// Add and rename ask for a name through a text flow (ADR-0009); flows.ts takes the answer.

export function categoriesView(view: CategoriesView, header?: Html): ScreenView {
  return {
    text: messages.categoriesScreen({ ...view, header }),
    markup: new InlineKeyboard()
      .text(messages.addCategoryButton, CATEGORY_ADD)
      .row()
      .text(messages.renameCategoryButton, categoryActionData('ren'))
      .text(messages.archiveCategoryButton, categoryActionData('arc')),
  };
}

// The prompt a flow shows in the anchor, with a refusal line above it when an answer failed.
export function promptView(
  flow: Flow,
  currentName: string | undefined,
  refusal?: Html,
): ScreenView {
  const prompt =
    flow.kind === 'categoryRename' && currentName !== undefined
      ? messages.renameCategoryPrompt(currentName)
      : messages.addCategoryPrompt;
  return {
    text: refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The categories screen for the ledger an anchor names, or undefined once the user left it.
export function categoriesScreenFor(
  deps: HandlerDeps,
  user: User,
  ledgerId: LedgerId,
  header?: Html,
): ScreenView | undefined {
  const view = ledgerCategories(deps, { user, ledgerId });
  return view === undefined ? undefined : categoriesView(view, header);
}

export async function sendCategories(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const view = activeLedgerCategories(deps, user);
  await showScreen(
    ctx,
    deps,
    user,
    { name: 'categories', ledgerId: view.ledger.id },
    categoriesView(view),
  );
}

// `categories` is the only screen so far, so an anchor that passes requireScreen shows it.
async function categoriesTap(ctx: Context, deps: HandlerDeps): Promise<ScreenTap | undefined> {
  return requireScreen(ctx, deps);
}

async function showPicker(
  ctx: Context,
  deps: HandlerDeps,
  tap: ScreenTap,
  action: CategoryAction,
  page: number,
): Promise<void> {
  const view = ledgerCategories(deps, { user: tap.user, ledgerId: tap.anchor.screen.ledgerId });
  if (view === undefined) {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return;
  }
  await ctx.answerCallbackQuery();
  const choices = action === 'arc' ? archivableCategories(view.categories) : view.categories;
  const shown = pageOf(choices, page);
  await renderAnchor(ctx, tap.anchor, {
    text: action === 'arc' ? messages.archivePicker : messages.renamePicker,
    markup: pickerKeyboard(
      shown.items.map((c) => InlineKeyboard.text(c.name, categoryActionPickData(action, c.id))),
      pagerRow(shown, (p) => categoryActionPageData(action, p)),
      CATEGORIES_OPEN,
    ),
  });
}

export function registerCategories(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('categories', (ctx) => sendCategories(ctx, deps));

  bot.callbackQuery(CATEGORIES_OPEN, async (ctx) => {
    const tap = await categoriesTap(ctx, deps);
    if (tap === undefined) return;
    const view = categoriesScreenFor(deps, tap.user, tap.anchor.screen.ledgerId);
    await ctx.answerCallbackQuery(view === undefined ? { text: messages.staleScreen } : {});
    if (view !== undefined) await renderAnchor(ctx, tap.anchor, view);
  });

  bot.callbackQuery(CATEGORY_ADD, async (ctx) => {
    const tap = await categoriesTap(ctx, deps);
    if (tap === undefined) return;
    const flow: Flow = { kind: 'categoryAdd', ledgerId: tap.anchor.screen.ledgerId };
    const result = startAdd(deps, { user: tap.user, ledgerId: flow.ledgerId, now: deps.now() });
    if (result.kind !== 'started') {
      await ctx.answerCallbackQuery({
        text: result.kind === 'limit' ? messages.categoryLimitToast : messages.staleScreen,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, promptView(flow, undefined));
  });

  bot.callbackQuery(CATEGORY_RENAME_PAGE, async (ctx) => {
    const tap = await categoriesTap(ctx, deps);
    if (tap === undefined) return;
    await showPicker(ctx, deps, tap, 'ren', Number(ctx.match[1] ?? 1));
  });

  bot.callbackQuery(CATEGORY_ARCHIVE_PAGE, async (ctx) => {
    const tap = await categoriesTap(ctx, deps);
    if (tap === undefined) return;
    await showPicker(ctx, deps, tap, 'arc', Number(ctx.match[1] ?? 1));
  });

  bot.callbackQuery(CATEGORY_RENAME, async (ctx) => {
    const tap = await categoriesTap(ctx, deps);
    if (tap === undefined) return;
    const { ledgerId } = tap.anchor.screen;
    const categoryId = Number(ctx.match[1]) as CategoryId;
    const result = startRename(deps, { user: tap.user, ledgerId, categoryId, now: deps.now() });
    if (result.kind !== 'started' || result.category === undefined) {
      await ctx.answerCallbackQuery({ text: messages.categoryGoneToast });
      return;
    }
    await ctx.answerCallbackQuery();
    await renderAnchor(
      ctx,
      tap.anchor,
      promptView({ kind: 'categoryRename', ledgerId, categoryId }, result.category.name),
    );
  });

  bot.callbackQuery(CATEGORY_ARCHIVE, async (ctx) => {
    const tap = await categoriesTap(ctx, deps);
    if (tap === undefined) return;
    const { ledgerId } = tap.anchor.screen;
    const categoryId = Number(ctx.match[1]) as CategoryId;
    const result = hideCategory(deps, { user: tap.user, ledgerId, categoryId, now: deps.now() });
    if (result.kind !== 'archived') {
      await ctx.answerCallbackQuery({
        text:
          result.kind === 'fallback' ? messages.fallbackCategoryToast : messages.categoryGoneToast,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    const view = categoriesScreenFor(
      deps,
      tap.user,
      ledgerId,
      messages.categoryArchived(result.category.name),
    );
    if (view !== undefined) await renderAnchor(ctx, tap.anchor, view);
  });
}
