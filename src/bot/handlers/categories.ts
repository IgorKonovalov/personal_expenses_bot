import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { CategoryId } from '../../db/categories.js';
import type { User } from '../../db/users.js';
import type { CategoriesScreen, CategoryFlow } from '../../services/flowSessions.js';
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
  SETTINGS_OPEN,
  type CategoryAction,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow, pickerKeyboard } from '../nav.js';
import { joinHtml, type Html } from '../render/html.js';
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

// The /categories screen (ADR-0011): the ledger's active categories, with add, rename and hide.
// Add and rename ask for a name through a text flow (ADR-0009); flows.ts takes the answer.

// Opened from the settings hub, the screen gets [« Назад] back to it.
export function categoriesView(
  view: CategoriesView,
  screen: Pick<CategoriesScreen, 'fromSettings'>,
  header?: Html,
): ScreenView {
  const markup = InlineKeyboard.from([
    [InlineKeyboard.text(messages.addCategoryButton, CATEGORY_ADD)],
    [
      InlineKeyboard.text(messages.renameCategoryButton, categoryActionData('ren')),
      InlineKeyboard.text(messages.archiveCategoryButton, categoryActionData('arc')),
    ],
    ...(screen.fromSettings === true ? [backRow(SETTINGS_OPEN)] : []),
  ]);
  return { text: messages.categoriesScreen({ ...view, header }), markup };
}

// The prompt a flow shows in the anchor, with a refusal line above it when an answer failed.
export function promptView(
  flow: CategoryFlow,
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
  screen: CategoriesScreen,
  header?: Html,
): ScreenView | undefined {
  const view = ledgerCategories(deps, { user, ledgerId: screen.ledgerId });
  return view === undefined ? undefined : categoriesView(view, screen, header);
}

export async function sendCategories(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const view = activeLedgerCategories(deps, user);
  const screen: CategoriesScreen = { name: 'categories', ledgerId: view.ledger.id };
  await showScreen(ctx, deps, user, screen, categoriesView(view, screen));
}

interface CategoriesTap extends ScreenTap {
  readonly screen: CategoriesScreen;
}

// A categories callback on an anchor that shows another screen is stale.
async function categoriesTap(ctx: Context, deps: HandlerDeps): Promise<CategoriesTap | undefined> {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  const { screen } = tap.anchor;
  if (screen.name !== 'categories') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { ...tap, screen };
}

async function showPicker(
  ctx: Context,
  deps: HandlerDeps,
  tap: CategoriesTap,
  action: CategoryAction,
  page: number,
): Promise<void> {
  const view = ledgerCategories(deps, { user: tap.user, ledgerId: tap.screen.ledgerId });
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
    const view = categoriesScreenFor(deps, tap.user, tap.screen);
    await ctx.answerCallbackQuery(view === undefined ? { text: messages.staleScreen } : {});
    if (view !== undefined) await renderAnchor(ctx, tap.anchor, view);
  });

  bot.callbackQuery(CATEGORY_ADD, async (ctx) => {
    const tap = await categoriesTap(ctx, deps);
    if (tap === undefined) return;
    const flow: CategoryFlow = { kind: 'categoryAdd', ledgerId: tap.screen.ledgerId };
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
    const { ledgerId } = tap.screen;
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
    const { ledgerId } = tap.screen;
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
      tap.screen,
      messages.categoryArchived(result.category.name),
    );
    if (view !== undefined) await renderAnchor(ctx, tap.anchor, view);
  });
}
