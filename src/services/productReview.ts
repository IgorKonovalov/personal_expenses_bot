import { setItemProduct } from '../db/itemProducts.js';
import type { LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import type { Money } from '../domain/money.js';
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
