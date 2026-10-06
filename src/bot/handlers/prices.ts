import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { setAnchor, type PricesScreen } from '../../services/flowSessions.js';
import { isLocked } from '../../services/ledgerKeys.js';
import {
  activeProductList,
  ledgerProduct,
  ledgerProductList,
  type LedgerItems,
  type ProductList,
  type ProductView,
} from '../../services/productPrices.js';
import {
  answerName,
  nameInfo,
  pickerProducts,
  productNames,
  reviewableItems,
  reviewQueue,
} from '../../services/productReview.js';
import type { HandlerDeps } from '../bot.js';
import {
  NAME_PICK,
  NAMES_PAGE,
  PRICES_PAGE,
  PRICES_REVIEW,
  PRODUCT_NAMES,
  PRODUCT_OPEN,
  REVIEW_ANSWER,
  REVIEW_PAGE,
  namePickData,
  namesPageData,
  pricesPageData,
  productNamesData,
  productOpenData,
  reviewAnswerData,
  reviewPageData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow } from '../nav.js';
import { replyHtml } from '../render/html.js';
import {
  backRow,
  renderAnchor,
  requireScreen,
  showScreen,
  type ScreenTap,
  type ScreenView,
} from '../screens.js';
import { ensureUser } from './start.js';

// /prices (ADR-0039): a screen on the anchor listing the viewer's products in the ledger it was
// opened on, PAGE_SIZE to a page, each a button to its months. [Разобрать] walks the names no
// product claims, and a product's [Названия] its own names, through one product picker; the
// names and the position live in the anchor's screen, so no item name is in callback data.

function pairs(buttons: readonly InlineKeyboardButton[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

export function priceListView(list: ProductList, requested: number): ScreenView {
  const shown = pageOf(list.products, requested);
  const rows = pairs(
    shown.items.map((product) =>
      InlineKeyboard.text(messages.productButton(product.name), productOpenData(product.ref)),
    ),
  );
  const pager = pagerRow(shown, pricesPageData);
  if (pager.length > 0) rows.push(pager);
  if (list.unmatched > 0) rows.push([InlineKeyboard.text(messages.reviewButton, PRICES_REVIEW)]);
  return {
    text: messages.priceList({
      ledger: list.ledger,
      products: shown.items,
      unmatched: list.unmatched,
    }),
    markup: InlineKeyboard.from(rows),
  };
}

function listOrEmpty(list: ProductList, page: number): ScreenView {
  return list.products.length === 0 && list.unmatched === 0
    ? { text: messages.pricesEmpty, markup: new InlineKeyboard() }
    : priceListView(list, page);
}

function productView(product: ProductView): ScreenView {
  return {
    text: messages.productView(product),
    markup: InlineKeyboard.from([
      ...(product.reviewable
        ? [[InlineKeyboard.text(messages.namesButton, productNamesData(product.ref))]]
        : []),
      backRow(pricesPageData(1)),
    ]),
  };
}

// /prices and its [☰ Ещё] button: page 1 of the active ledger's products, as a new anchor.
export async function sendPrices(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  const list = activeProductList(deps, user, now);
  if (isLocked(list)) {
    await replyHtml(ctx, messages.ledgerLocked);
    return;
  }
  await showScreen(
    ctx,
    deps,
    user,
    { name: 'prices', ledgerId: list.ledger.id },
    listOrEmpty(list, 1),
  );
}

interface PricesTap extends ScreenTap {
  readonly screen: PricesScreen;
}

// The prologue of a prices tap: the anchor must show the prices screen.
async function pricesTap(ctx: Context, deps: HandlerDeps): Promise<PricesTap | undefined> {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  const { screen } = tap.anchor;
  if (screen.name !== 'prices') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { ...tap, screen };
}

// Stores the screen's new state on the same anchor message.
function saveScreen(deps: HandlerDeps, tap: PricesTap, screen: PricesScreen): void {
  setAnchor(deps, tap.user, { chatId: tap.anchor.chatId, messageId: tap.anchor.messageId, screen });
}

const plain = (tap: PricesTap): PricesScreen => ({ name: 'prices', ledgerId: tap.screen.ledgerId });

async function showList(
  ctx: Context,
  deps: HandlerDeps,
  tap: PricesTap,
  page: number,
  toast?: string,
): Promise<void> {
  const list = ledgerProductList(deps, {
    user: tap.user,
    ledgerId: tap.screen.ledgerId,
    now: deps.now(),
  });
  if (isLocked(list)) {
    await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
    return;
  }
  await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });
  if (list === undefined) return;
  saveScreen(deps, tap, plain(tap));
  await renderAnchor(ctx, tap.anchor, listOrEmpty(list, page));
}

async function showProduct(
  ctx: Context,
  deps: HandlerDeps,
  tap: PricesTap,
  ref: string,
): Promise<void> {
  const product = ledgerProduct(deps, { user: tap.user, ledgerId: tap.screen.ledgerId, ref });
  if (isLocked(product)) {
    await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
    return;
  }
  if (product === undefined) {
    await showList(ctx, deps, tap, 1, messages.productGone);
    return;
  }
  await ctx.answerCallbackQuery();
  saveScreen(deps, tap, plain(tap));
  await renderAnchor(ctx, tap.anchor, productView(product));
}

// The ledger's items for a review tap, or undefined once the tap is answered: a locked ledger
// gets the locked toast, a sealed one or a former member the stale toast.
async function reviewItems(
  ctx: Context,
  deps: HandlerDeps,
  tap: PricesTap,
): Promise<LedgerItems | undefined> {
  const resolved = reviewableItems(deps, { user: tap.user, ledgerId: tap.screen.ledgerId });
  if (resolved === undefined || resolved === 'sealed') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  if (isLocked(resolved)) {
    await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
    return undefined;
  }
  return resolved;
}

// The picker for the name at `position` of `names`, or undefined when no item carries it now.
function stepView(
  resolved: LedgerItems,
  review: {
    readonly names: readonly string[];
    readonly position: number;
    readonly product?: string;
  },
  page: number,
): ScreenView | undefined {
  const { names, position, product } = review;
  const nameKey = names[position];
  const info = nameKey === undefined ? undefined : nameInfo(resolved, nameKey);
  if (info === undefined) return undefined;
  const shown = pageOf(pickerProducts(resolved), page);
  const rows = pairs(
    shown.items.map((p) =>
      InlineKeyboard.text(messages.productButton(p.name), reviewAnswerData(position, p.ref)),
    ),
  );
  const pager = pagerRow(shown, reviewPageData);
  if (pager.length > 0) rows.push(pager);
  rows.push([
    InlineKeyboard.text(messages.notProductButton, reviewAnswerData(position, 'n')),
    InlineKeyboard.text(messages.skipNameButton, reviewAnswerData(position, 's')),
  ]);
  rows.push(backRow(product === undefined ? pricesPageData(1) : namesPageData(1)));
  const current = resolved.items.find((item) => item.nameKey === info.nameKey)?.ref;
  return {
    text: messages.reviewStep({
      ...info,
      ...(product === undefined ? { step: { index: position + 1, total: names.length } } : {}),
      ...(product === undefined || current === undefined
        ? {}
        : { product: resolved.products.get(current)?.name ?? '' }),
    }),
    markup: InlineKeyboard.from(rows),
  };
}

// The queue from `position` on: the first name some item still carries, or the list once none
// is left.
async function showQueueFrom(
  ctx: Context,
  deps: HandlerDeps,
  tap: PricesTap,
  resolved: LedgerItems,
  names: readonly string[],
  position: number,
): Promise<void> {
  for (let at = position; at < names.length; at++) {
    const view = stepView(resolved, { names, position: at }, 1);
    if (view === undefined) continue;
    await ctx.answerCallbackQuery();
    saveScreen(deps, tap, { ...plain(tap), names, position: at });
    await renderAnchor(ctx, tap.anchor, view);
    return;
  }
  await showList(ctx, deps, tap, 1);
}

function namesView(
  resolved: LedgerItems,
  ref: string,
  names: readonly string[],
  page: number,
): ScreenView {
  const purchases = new Map(productNames(resolved, ref).map((n) => [n.nameKey, n.purchases]));
  const indexed = names.map((nameKey, index) => ({ nameKey, index }));
  const shown = pageOf(indexed, page);
  const rows: InlineKeyboardButton[][] = shown.items.map(({ nameKey, index }) => [
    InlineKeyboard.text(
      messages.nameButton(nameKey, purchases.get(nameKey) ?? 0),
      namePickData(index),
    ),
  ]);
  const pager = pagerRow(shown, namesPageData);
  if (pager.length > 0) rows.push(pager);
  rows.push(backRow(productOpenData(ref)));
  const name = [...resolved.products.values()].find((p) => p.ref === ref)?.name ?? '';
  return { text: messages.productNamesView(name), markup: InlineKeyboard.from(rows) };
}

export function registerPrices(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('prices', (ctx) => sendPrices(ctx, deps));

  bot.callbackQuery(PRICES_PAGE, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    await showList(ctx, deps, tap, Number(ctx.match[1]));
  });

  bot.callbackQuery(PRODUCT_OPEN, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    await showProduct(ctx, deps, tap, ctx.match[1] ?? '');
  });

  bot.callbackQuery(PRICES_REVIEW, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const resolved = await reviewItems(ctx, deps, tap);
    if (resolved === undefined) return;
    await showQueueFrom(ctx, deps, tap, resolved, reviewQueue(resolved), 0);
  });

  bot.callbackQuery(REVIEW_PAGE, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const { names, position, product } = tap.screen;
    if (names === undefined || position === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const resolved = await reviewItems(ctx, deps, tap);
    if (resolved === undefined) return;
    const view = stepView(
      resolved,
      { names, position, ...(product === undefined ? {} : { product }) },
      Number(ctx.match[1]),
    );
    await ctx.answerCallbackQuery();
    if (view !== undefined) await renderAnchor(ctx, tap.anchor, view);
  });

  // An answer is applied to the name at the position it carries, so a double tap writes the
  // same answer again and the queue moves on once.
  bot.callbackQuery(REVIEW_ANSWER, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const position = Number(ctx.match[1]);
    const choice = ctx.match[2] ?? 's';
    const { names, product } = tap.screen;
    const nameKey = names?.[position];
    if (names === undefined || nameKey === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    if (choice !== 's') {
      const result = answerName(deps, {
        user: tap.user,
        ledgerId: tap.screen.ledgerId,
        nameKey,
        answer: choice === 'n' ? null : choice,
        now: deps.now(),
      });
      if (isLocked(result)) {
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      }
      if (result?.kind !== 'answered') {
        await ctx.answerCallbackQuery({ text: messages.staleScreen });
        return;
      }
    }
    if (product !== undefined) {
      await showProduct(ctx, deps, tap, product);
      return;
    }
    const resolved = await reviewItems(ctx, deps, tap);
    if (resolved === undefined) return;
    const next = Math.max(tap.screen.position ?? 0, position + 1);
    await showQueueFrom(ctx, deps, tap, resolved, names, next);
  });

  bot.callbackQuery(PRODUCT_NAMES, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const ref = ctx.match[1] ?? '';
    const resolved = await reviewItems(ctx, deps, tap);
    if (resolved === undefined) return;
    const names = productNames(resolved, ref).map((n) => n.nameKey);
    if (names.length === 0) {
      await showList(ctx, deps, tap, 1, messages.productGone);
      return;
    }
    await ctx.answerCallbackQuery();
    saveScreen(deps, tap, { ...plain(tap), names, product: ref });
    await renderAnchor(ctx, tap.anchor, namesView(resolved, ref, names, 1));
  });

  bot.callbackQuery(NAMES_PAGE, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const { names, product } = tap.screen;
    if (names === undefined || product === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const resolved = await reviewItems(ctx, deps, tap);
    if (resolved === undefined) return;
    await ctx.answerCallbackQuery();
    saveScreen(deps, tap, { ...plain(tap), names, product });
    await renderAnchor(ctx, tap.anchor, namesView(resolved, product, names, Number(ctx.match[1])));
  });

  bot.callbackQuery(NAME_PICK, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const position = Number(ctx.match[1]);
    const { names, product } = tap.screen;
    if (names?.[position] === undefined || product === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const resolved = await reviewItems(ctx, deps, tap);
    if (resolved === undefined) return;
    const view = stepView(resolved, { names, position, product }, 1);
    if (view === undefined) {
      await showProduct(ctx, deps, tap, product);
      return;
    }
    await ctx.answerCallbackQuery();
    saveScreen(deps, tap, { ...plain(tap), names, position, product });
    await renderAnchor(ctx, tap.anchor, view);
  });
}
