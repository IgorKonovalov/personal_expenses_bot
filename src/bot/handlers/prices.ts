import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { User } from '../../db/users.js';
import { encodeBarsPayload } from '../../domain/chartPayload.js';
import {
  setAnchor,
  startFlow,
  type PricesScreen,
  type ProductNameFlow,
  type ScreenAnchor,
} from '../../services/flowSessions.js';
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
  createUserProduct,
  nameInfo,
  nameNewProduct,
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
  PRODUCT_NEW,
  PRODUCT_OPEN,
  PRODUCT_UNIT,
  REVIEW_ANSWER,
  REVIEW_PAGE,
  namePickData,
  namesPageData,
  pricesPageData,
  productNamesData,
  productOpenData,
  productUnitData,
  reviewAnswerData,
  reviewPageData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow } from '../nav.js';
import { replyHtml, type Html } from '../render/html.js';
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

function productView(product: ProductView, chartUrl: string | undefined): ScreenView {
  return {
    text: messages.productView(product),
    markup: InlineKeyboard.from([
      ...(chartUrl === undefined ? [] : [[InlineKeyboard.webApp(messages.chartButton, chartUrl)]]),
      ...(product.reviewable
        ? [[InlineKeyboard.text(messages.namesButton, productNamesData(product.ref))]]
        : []),
      backRow(pricesPageData(1)),
    ]),
  };
}

// The chart button's URL: WEBAPP_URL with the product's price per unit and spend by month in the
// fragment's `z` (ADR-0025, ADR-0045), from the month lines the text shows. Undefined outside a
// private chat (`web_app` buttons work only there), without WEBAPP_URL, for a product with no
// month in the ledger's currency, and when the payload can't fit its budget. A locked sealed
// ledger never gets here: its tap is the locked toast.
function chartUrlOf(ctx: Context, deps: HandlerDeps, product: ProductView): string | undefined {
  if (ctx.chat?.type !== 'private' || deps.webappUrl === undefined) return undefined;
  const currency = product.ledger.defaultCurrency;
  if (!product.months.some((m) => m.currency === currency)) return undefined;
  const payload = encodeBarsPayload(messages.productChart({ ...product, currency }));
  return payload === undefined ? undefined : `${deps.webappUrl}#z=${payload}`;
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
  await renderAnchor(ctx, tap.anchor, productView(product, chartUrlOf(ctx, deps, product)));
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
  rows.push([InlineKeyboard.text(messages.newProductButton, PRODUCT_NEW)]);
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

// What the anchor's prices screen shows while a review name is open, re-rendered after a
// cancelled prompt: that name's picker. Undefined outside a review.
export function pricesScreenFor(
  deps: HandlerDeps,
  user: User,
  screen: PricesScreen,
): ScreenView | undefined {
  const { names, position, product } = screen;
  if (names === undefined || position === undefined) return undefined;
  const resolved = reviewableItems(deps, { user, ledgerId: screen.ledgerId });
  if (resolved === undefined || resolved === 'sealed' || isLocked(resolved)) return undefined;
  return stepView(resolved, { names, position, ...(product === undefined ? {} : { product }) }, 1);
}

function namePromptView(nameKey: string, refusal?: Html): ScreenView {
  return {
    text: messages.newProductPrompt(nameKey, refusal),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The answer to [Новый продукт]'s prompt. A valid name puts the unit picker in the anchor; an
// invalid one re-asks there.
export async function answerProductName(
  ctx: Context,
  deps: HandlerDeps,
  anchor: ScreenAnchor | undefined,
  input: {
    readonly user: User;
    readonly flow: ProductNameFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const result = nameNewProduct(deps, input);
  if (anchor?.screen.name !== 'prices') return;
  const nameKey = anchor.screen.names?.[anchor.screen.position ?? -1] ?? '';
  switch (result.kind) {
    case 'invalid':
      await renderAnchor(
        ctx,
        anchor,
        namePromptView(
          nameKey,
          result.reason === 'length'
            ? messages.newProductRefused.length
            : messages.newProductRefused.catalog(result.catalogName),
        ),
      );
      return;
    case 'gone': {
      const view = pricesScreenFor(deps, input.user, anchor.screen);
      if (view !== undefined) await renderAnchor(ctx, anchor, view);
      return;
    }
    case 'named':
      await renderAnchor(ctx, anchor, {
        text: messages.unitPrompt(result.name),
        markup: InlineKeyboard.from([
          UNITS.map((unit) =>
            InlineKeyboard.text(messages.unitButtons[unit], productUnitData(unit)),
          ),
          backRow(reviewPageData(1)),
        ]),
      });
      return;
  }
}

const UNITS = ['l', 'kg', 'pcs'] as const;

// After the name at `position` was answered: back to the product its names were opened from,
// or on to the queue's next name.
async function afterAnswer(
  ctx: Context,
  deps: HandlerDeps,
  tap: PricesTap,
  position: number,
): Promise<void> {
  const { names, product } = tap.screen;
  if (product !== undefined) {
    await showProduct(ctx, deps, tap, product);
    return;
  }
  if (names === undefined) {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return;
  }
  const resolved = await reviewItems(ctx, deps, tap);
  if (resolved === undefined) return;
  const next = Math.max(tap.screen.position ?? 0, position + 1);
  await showQueueFrom(ctx, deps, tap, resolved, names, next);
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
    const nameKey = tap.screen.names?.[position];
    if (nameKey === undefined) {
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
    await afterAnswer(ctx, deps, tap, position);
  });

  // [Новый продукт]: the name prompt in the anchor, as a text flow.
  bot.callbackQuery(PRODUCT_NEW, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const nameKey = tap.screen.names?.[tap.screen.position ?? -1];
    if (nameKey === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const resolved = await reviewItems(ctx, deps, tap);
    if (resolved === undefined) return;
    await ctx.answerCallbackQuery();
    startFlow(deps, tap.user, { kind: 'productName', ledgerId: tap.screen.ledgerId }, deps.now());
    await renderAnchor(ctx, tap.anchor, namePromptView(nameKey));
  });

  // A unit for the typed name: the product is created and the name under review assigned to it.
  // A double tap finds the name consumed and changes nothing.
  bot.callbackQuery(PRODUCT_UNIT, async (ctx) => {
    const tap = await pricesTap(ctx, deps);
    if (tap === undefined) return;
    const unit = UNITS.find((u) => u === ctx.match[1]) ?? 'pcs';
    const result = createUserProduct(deps, { user: tap.user, unit, now: deps.now() });
    switch (result.kind) {
      case 'locked':
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      case 'sealed':
        await ctx.answerCallbackQuery({ text: messages.staleScreen });
        return;
      case 'stale':
        await ctx.answerCallbackQuery();
        return;
      case 'created':
        await afterAnswer(ctx, deps, tap, tap.screen.position ?? 0);
        return;
    }
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
