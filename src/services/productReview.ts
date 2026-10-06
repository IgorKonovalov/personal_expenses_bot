import { setItemProduct } from '../db/itemProducts.js';
import type { LedgerId } from '../db/ledgers.js';
import { insertUserProduct } from '../db/userProducts.js';
import type { User } from '../db/users.js';
import type { Money } from '../domain/money.js';
import type { Unit } from '../domain/products/amount.js';
import { CATALOG } from '../domain/products/catalog.js';
import {
  cancelFlow,
  completeFlow,
  currentAnchor,
  setAnchor,
  type PricesScreen,
  type ProductNameFlow,
} from './flowSessions.js';
import { isLocked, type Locked } from './ledgerKeys.js';
import {
  ledgerItems,
  unmatchedNames,
  type LedgerItems,
  type Product,
  type ProductDeps,
  type ProductRef,
} from './productPrices.js';

// The review of item names (ADR-0039): the names no rule matched, one at a time, each answered
// with a product, "not a product" or skipped; and any name counted under a product, corrected the
// same way. An answer is an override keyed by the user and the normalized name, so answering the
// same name twice rewrites one row. A sealed ledger is never reviewed.

export interface NameInfo {
  readonly nameKey: string;
  readonly purchases: number;
  // The most recent purchase's total.
  readonly latest: Money;
}

type Reviewable = LedgerItems | Locked | 'sealed' | undefined;

// The screen's ledger, open and reviewable: `sealed` for a sealed one, undefined for a
// non-member.
export function reviewableItems(
  deps: ProductDeps,
  input: { readonly user: User; readonly ledgerId: LedgerId },
): Reviewable {
  const resolved = ledgerItems(deps, input);
  if (resolved === undefined || isLocked(resolved)) return resolved;
  return resolved.sealed ? 'sealed' : resolved;
}

// The names awaiting review, most purchased first.
export function reviewQueue(resolved: LedgerItems): string[] {
  return unmatchedNames(resolved);
}

export function nameInfo(resolved: LedgerItems, nameKey: string): NameInfo | undefined {
  const items = resolved.items.filter((item) => item.nameKey === nameKey);
  const last = items.at(-1);
  if (last === undefined) return undefined;
  return {
    nameKey,
    purchases: items.length,
    latest: { amountMinor: last.totalMinor, currency: last.currency },
  };
}

// The names counted under a product, most purchased first.
export function productNames(
  resolved: LedgerItems,
  ref: string,
): { readonly nameKey: string; readonly purchases: number }[] {
  const counts = new Map<string, number>();
  for (const item of resolved.items) {
    if (item.ref === undefined || item.ref !== ref) continue;
    counts.set(item.nameKey, (counts.get(item.nameKey) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([nameKey, purchases]) => ({ nameKey, purchases }));
}

// What a name can be assigned to: the products the user already buys, most items first, then
// every other product in catalog order.
export function pickerProducts(resolved: LedgerItems): Product[] {
  const counts = new Map<ProductRef, number>();
  for (const item of resolved.items) {
    if (item.ref !== undefined) counts.set(item.ref, (counts.get(item.ref) ?? 0) + 1);
  }
  const all = [...resolved.products.values()];
  const index = new Map(all.map((product, i) => [product.ref, i]));
  return all.sort(
    (a, b) =>
      (counts.get(b.ref) ?? 0) - (counts.get(a.ref) ?? 0) ||
      (index.get(a.ref) ?? 0) - (index.get(b.ref) ?? 0),
  );
}

export type AnswerResult =
  | { readonly kind: 'answered' }
  // The answer names no product the user can assign.
  | { readonly kind: 'unknownProduct' }
  | { readonly kind: 'sealed' }
  | Locked;

// The longest name a user product takes.
export const MAX_PRODUCT_NAME = 40;

export type NameNewProductResult =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'invalid'; readonly reason: 'length' }
  // The name is a catalog product's, compared case-insensitively.
  | { readonly kind: 'invalid'; readonly reason: 'catalog'; readonly catalogName: string }
  // The anchor no longer shows a name of this ledger's review: the flow is cancelled.
  | { readonly kind: 'gone' };

// The anchor's prices screen while it shows one name of a review, with that name.
function reviewStepOf(deps: ProductDeps, user: User) {
  const anchor = currentAnchor(deps, user);
  if (anchor?.screen.name !== 'prices') return undefined;
  const { screen } = anchor;
  const nameKey = screen.names?.[screen.position ?? -1];
  return nameKey === undefined ? undefined : { anchor, screen, nameKey };
}

// The prices screen without the name awaiting its unit.
function withoutNewProduct(screen: PricesScreen): PricesScreen {
  const { name, ledgerId, names, position, product } = screen;
  return {
    name,
    ledgerId,
    ...(names === undefined ? {} : { names }),
    ...(position === undefined ? {} : { position }),
    ...(product === undefined ? {} : { product }),
  };
}

// A name typed for [Новый продукт]. A valid one completes the flow and waits on the anchor's
// screen for its unit, in one transaction, so a redelivered text finds the flow answered.
export function nameNewProduct(
  deps: ProductDeps,
  input: {
    readonly user: User;
    readonly flow: ProductNameFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): NameNewProductResult {
  const { user } = input;
  return deps.db.transaction((): NameNewProductResult => {
    const step = reviewStepOf(deps, user);
    if (step === undefined || step.screen.ledgerId !== input.flow.ledgerId) {
      cancelFlow(deps, user);
      return { kind: 'gone' };
    }
    const name = input.text.trim().replace(/\s+/g, ' ');
    if (name === '' || name.length > MAX_PRODUCT_NAME) return { kind: 'invalid', reason: 'length' };
    const folded = name.toLocaleLowerCase('ru');
    const clash = CATALOG.find((p) => p.name.toLocaleLowerCase('ru') === folded);
    if (clash !== undefined) return { kind: 'invalid', reason: 'catalog', catalogName: clash.name };
    completeFlow(deps, user, input.inputKey);
    setAnchor(deps, user, { ...step.anchor, screen: { ...step.screen, newProduct: name } });
    return { kind: 'named', name };
  })();
}

export type CreateProductResult =
  | { readonly kind: 'created'; readonly ref: ProductRef }
  // No name awaits a unit: a second tap, or a screen that moved on.
  | { readonly kind: 'stale' }
  | { readonly kind: 'sealed' }
  | Locked;

// A unit tap: creates the product the anchor's screen holds a name for, assigns the review's
// current name to it, and drops the held name, in one transaction. The held name is the step a
// double tap finds consumed, so it creates one product.
export function createUserProduct(
  deps: ProductDeps,
  input: { readonly user: User; readonly unit: Unit; readonly now: Date },
): CreateProductResult {
  const { db } = deps;
  const { user } = input;
  return db.transaction((): CreateProductResult => {
    const step = reviewStepOf(deps, user);
    const name = step?.screen.newProduct;
    if (step === undefined || name === undefined) return { kind: 'stale' };
    const resolved = reviewableItems(deps, { user, ledgerId: step.screen.ledgerId });
    if (resolved === undefined) return { kind: 'stale' };
    if (resolved === 'sealed') return { kind: 'sealed' };
    if (isLocked(resolved)) return resolved;
    const id = insertUserProduct(db, { userId: user.id, name, unit: input.unit, at: input.now });
    const ref: ProductRef = `u:${id}`;
    setItemProduct(db, user.id, step.nameKey, ref, input.now);
    setAnchor(deps, user, { ...step.anchor, screen: withoutNewProduct(step.screen) });
    deps.logger.info({ userId: user.id, productId: id }, 'user product created');
    return { kind: 'created', ref };
  })();
}

// Assigns `nameKey` to the product `answer` names, or to "not a product" for null.
export function answerName(
  deps: ProductDeps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly nameKey: string;
    readonly answer: string | null;
    readonly now: Date;
  },
): AnswerResult | undefined {
  const resolved = reviewableItems(deps, input);
  if (resolved === undefined || resolved === 'sealed' || isLocked(resolved)) {
    return resolved === 'sealed' ? { kind: 'sealed' } : resolved;
  }
  const { answer } = input;
  if (answer !== null && ![...resolved.products.keys()].some((ref) => ref === answer)) {
    return { kind: 'unknownProduct' };
  }
  setItemProduct(deps.db, input.user.id, input.nameKey, answer, input.now);
  return { kind: 'answered' };
}
