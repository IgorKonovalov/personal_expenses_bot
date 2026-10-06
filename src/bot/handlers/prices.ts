import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { LedgerId } from '../../db/ledgers.js';
import { isLocked } from '../../services/ledgerKeys.js';
import {
  activeProductList,
  ledgerProduct,
  ledgerProductList,
  type ProductList,
} from '../../services/productPrices.js';
import type { HandlerDeps } from '../bot.js';
import { PRICES_PAGE, PRODUCT_OPEN, pricesPageData, productOpenData } from '../callbackData.js';
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
// opened on, PAGE_SIZE to a page, each a button to its months.

export function priceListView(list: ProductList, requested: number): ScreenView {
  const shown = pageOf(list.products, requested);
  const buttons = shown.items.map((product) =>
    InlineKeyboard.text(messages.productButton(product.name), productOpenData(product.ref)),
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  const pager = pagerRow(shown, pricesPageData);
  if (pager.length > 0) rows.push(pager);
  return {
    text: messages.priceList({ ledger: list.ledger, products: shown.items }),
    markup: InlineKeyboard.from(rows),
  };
}

function listOrEmpty(list: ProductList, page: number): ScreenView {
  return list.products.length === 0
    ? { text: messages.pricesEmpty, markup: new InlineKeyboard() }
    : priceListView(list, page);
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

// The prologue of a prices tap: the anchor must show the prices screen.
async function pricesTap(ctx: Context, deps: HandlerDeps) {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  const { screen } = tap.anchor;
  if (screen.name !== 'prices') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { ...tap, ledgerId: screen.ledgerId };
}

async function showList(
  ctx: Context,
  deps: HandlerDeps,
  tap: ScreenTap & { readonly ledgerId: LedgerId },
  page: number,
  toast?: string,
): Promise<void> {
  const list = ledgerProductList(deps, { user: tap.user, ledgerId: tap.ledgerId, now: deps.now() });
  if (isLocked(list)) {
    await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
    return;
  }
  await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });
  if (list !== undefined) await renderAnchor(ctx, tap.anchor, listOrEmpty(list, page));
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
    const product = ledgerProduct(deps, {
      user: tap.user,
      ledgerId: tap.ledgerId,
      ref: ctx.match[1] ?? '',
    });
    if (isLocked(product)) {
      await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
      return;
    }
    if (product === undefined) {
      await showList(ctx, deps, tap, 1, messages.productGone);
      return;
    }
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, {
      text: messages.productView(product),
      markup: InlineKeyboard.from([backRow(pricesPageData(1))]),
    });
  });
}
