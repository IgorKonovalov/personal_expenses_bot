import { isSealed, listLedgerExpenses } from '../db/expenses.js';
import { listItemProducts } from '../db/itemProducts.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import { listLedgerDatedItems } from '../db/receiptItems.js';
import { listUserProducts } from '../db/userProducts.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { monthOf, previous } from '../domain/periods.js';
import { amountOf, type Unit } from '../domain/products/amount.js';
import { CATALOG } from '../domain/products/catalog.js';
import { createNameMatcher, matchProduct, type NameMatcher } from '../domain/products/match.js';
import {
  monthLines,
  totalLines,
  type MonthLine,
  type PriceLine,
  type PricedItem,
} from '../domain/products/monthly.js';
import { normalize } from '../domain/products/normalize.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import {
  foldedReceipt,
  isLocked,
  isSealedLedger,
  ledgerIsLocked,
  LOCKED,
  type KeyDeps,
  type Locked,
} from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// /prices (ADR-0039): the viewer's own receipt items in one ledger, grouped into products, with
// what each product cost per month. Only the viewer's live expenses with a fetched receipt count;
// a sealed ledger's items come from the receipts folded into its rows, and it must be unlocked.
// A name the user answered takes the answer's product; any other the keyword rules'. A sealed
// ledger uses the rules only and offers no review.

export type ProductDeps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> &
  Pick<KeyDeps, 'keys'>;

// `b:<catalog key>` or `u:<user_products.id>`: what a product is stored and travels as in
// callback data.
export type ProductRef = `b:${string}` | `u:${number}`;

export interface Product {
  readonly ref: ProductRef;
  readonly name: string;
  readonly unit: Unit;
}

export interface ResolvedItem {
  readonly nameKey: string;
  readonly quantity: string;
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredOn: LocalDate;
  // Undefined: no product, by the rules or by the user's "not a product".
  readonly ref: ProductRef | undefined;
  // The user answered this name: it is out of the review queue.
  readonly answered: boolean;
}

export interface LedgerItems {
  readonly ledger: Ledger;
  // A sealed ledger: rules only, no review.
  readonly sealed: boolean;
  // Oldest first.
  readonly items: readonly ResolvedItem[];
  // Every product a name can be assigned to, by ref.
  readonly products: ReadonlyMap<ProductRef, Product>;
}

export interface ProductSummary {
  readonly ref: ProductRef;
  readonly name: string;
  // Spent over the last 12 months, this one included, in the ledger's default currency.
  readonly recentMinor: number;
}

export interface ProductList {
  readonly ledger: Ledger;
  // By recentMinor, largest first, then by name.
  readonly products: readonly ProductSummary[];
  // Distinct names with no product that the user hasn't answered; 0 for a sealed ledger.
  readonly unmatched: number;
  readonly reviewable: boolean;
}

export interface ProductView {
  readonly ledger: Ledger;
  readonly ref: ProductRef;
  readonly name: string;
  readonly unit: Unit;
  // Newest month first; in a month, the default currency first, then by code.
  readonly months: readonly MonthLine[];
  // All time, ordered as in a month.
  readonly totals: readonly PriceLine[];
  readonly reviewable: boolean;
}

// The catalog in its order, then the user's own products, oldest first.
function productsOf(deps: ProductDeps, user: User): Map<ProductRef, Product> {
  const products: Product[] = [
    ...CATALOG.map(({ key, name, unit }): Product => ({ ref: `b:${key}`, name, unit })),
    ...listUserProducts(deps.db, user.id).map(({ id, name, unit }): Product => ({
      ref: `u:${id}`,
      name,
      unit,
    })),
  ];
  return new Map(products.map((product) => [product.ref, product]));
}

// The process's memo of plaintext item names to their key and rule product (ADR-0041). At the
// cap it holds an estimated 5 MB. Names only: no amount, user or date, and it is never logged.
export const NAME_MATCHER_CAPACITY = 20_000;
export const sharedNameMatcher: NameMatcher = createNameMatcher(NAME_MATCHER_CAPACITY);

interface RawItem {
  readonly nameKey: string;
  readonly ruleRef: ProductRef | undefined;
  readonly quantity: string;
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredOn: LocalDate;
}

function ruleRef(nameKey: string): ProductRef | undefined {
  const product = matchProduct(nameKey);
  return product === undefined ? undefined : `b:${product.key}`;
}

// The viewer's items in the ledger, oldest first.
function ownItems(deps: ProductDeps, user: User, ledger: Ledger, sealed: boolean): RawItem[] {
  const items: RawItem[] = listLedgerDatedItems(deps.db, ledger.id)
    .filter((item) => item.createdBy === user.id)
    .map((item) => ({ ...item, ...sharedNameMatcher.match(item.name) }));
  if (!sealed) return items;
  for (const row of listLedgerExpenses(deps.db, { ledgerId: ledger.id, memberId: user.id })) {
    if (!isSealed(row) || row.createdBy !== user.id) continue;
    const folded = foldedReceipt(deps, row.id);
    if (folded === undefined || folded.sellerName === null) continue;
    for (const item of folded.items) {
      const nameKey = normalize(item.name);
      items.push({
        nameKey,
        ruleRef: ruleRef(nameKey),
        quantity: item.quantity,
        totalMinor: item.totalMinor,
        currency: row.currency,
        occurredOn: row.occurredOn,
      });
    }
  }
  return items;
}

// The viewer's items with their products, or `locked` for a sealed ledger without its key.
export function resolveItems(deps: ProductDeps, user: User, ledger: Ledger): LedgerItems | Locked {
  if (ledgerIsLocked(deps, ledger.id)) return LOCKED;
  const sealed = isSealedLedger(deps, ledger.id);
  const products = productsOf(deps, user);
  const answers = sealed ? new Map<string, string | null>() : listItemProducts(deps.db, user.id);
  const items = ownItems(deps, user, ledger, sealed).map(({ ruleRef: rule, ...item }) => {
    if (!answers.has(item.nameKey)) return { ...item, ref: rule, answered: false };
    // An answer naming a product that no longer exists counts as "not a product".
    const answer = answers.get(item.nameKey) ?? null;
    const ref = answer === null ? undefined : products.get(answer as ProductRef)?.ref;
    return { ...item, ref, answered: true };
  });
  return { ledger, sealed, items, products };
}

// The ledger the screen was opened on, with the viewer's items. Undefined for a non-member.
export function ledgerItems(
  deps: ProductDeps,
  input: { readonly user: User; readonly ledgerId: LedgerId },
): LedgerItems | Locked | undefined {
  const ledger = findLedgerForMember(deps.db, input.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  return resolveItems(deps, input.user, ledger);
}

// The first day of the month 11 months before today's: the start of "the last 12 months".
function recentFrom(deps: ProductDeps, user: User, ledger: Ledger, now: Date): LocalDate {
  let month = monthOf(localDateOf(now, effectiveTimezone(deps, user, ledger)));
  for (let i = 0; i < 11; i++) month = previous(month);
  return month.from;
}

// The distinct names awaiting review: no product, never answered. By purchases, most first,
// then by name.
export function unmatchedNames(resolved: LedgerItems): string[] {
  if (resolved.sealed) return [];
  const counts = new Map<string, number>();
  for (const item of resolved.items) {
    if (item.ref !== undefined || item.answered) continue;
    counts.set(item.nameKey, (counts.get(item.nameKey) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([nameKey]) => nameKey);
}

function listOf(deps: ProductDeps, user: User, resolved: LedgerItems, now: Date): ProductList {
  const { ledger } = resolved;
  const from = recentFrom(deps, user, ledger, now);
  const recent = new Map<ProductRef, number>();
  for (const item of resolved.items) {
    if (item.ref === undefined) continue;
    const counts = item.occurredOn >= from && item.currency === ledger.defaultCurrency;
    recent.set(item.ref, (recent.get(item.ref) ?? 0) + (counts ? item.totalMinor : 0));
  }
  const products = [...recent].flatMap(([ref, recentMinor]) => {
    const name = resolved.products.get(ref)?.name;
    return name === undefined ? [] : [{ ref, name, recentMinor }];
  });
  products.sort((a, b) => b.recentMinor - a.recentMinor || a.name.localeCompare(b.name, 'ru'));
  return {
    ledger,
    products,
    unmatched: unmatchedNames(resolved).length,
    reviewable: !resolved.sealed,
  };
}

// /prices: the products of the user's active ledger.
export function activeProductList(deps: ProductDeps, user: User, now: Date): ProductList | Locked {
  const ledger = findActiveLedger(deps.db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  const resolved = resolveItems(deps, user, ledger);
  return isLocked(resolved) ? resolved : listOf(deps, user, resolved, now);
}

// A page of the list the screen was opened on. Undefined once the user is no longer a member.
export function ledgerProductList(
  deps: ProductDeps,
  input: { readonly user: User; readonly ledgerId: LedgerId; readonly now: Date },
): ProductList | Locked | undefined {
  const resolved = ledgerItems(deps, input);
  if (resolved === undefined || isLocked(resolved)) return resolved;
  return listOf(deps, input.user, resolved, input.now);
}

// The ledger's default currency first, then by code.
function byCurrency(ledger: Ledger) {
  const rank = (line: PriceLine) => (line.currency === ledger.defaultCurrency ? 0 : 1);
  return (a: PriceLine, b: PriceLine): number =>
    rank(a) - rank(b) || a.currency.localeCompare(b.currency);
}

// One product of the screen's ledger. Undefined for a non-member, an unknown ref, or a product
// none of the user's items names any more.
export function ledgerProduct(
  deps: ProductDeps,
  input: { readonly user: User; readonly ledgerId: LedgerId; readonly ref: string },
): ProductView | Locked | undefined {
  const resolved = ledgerItems(deps, input);
  if (resolved === undefined || isLocked(resolved)) return resolved;
  const { ledger } = resolved;
  const mine = resolved.items.filter((item) => item.ref !== undefined && item.ref === input.ref);
  const product = mine[0]?.ref === undefined ? undefined : resolved.products.get(mine[0].ref);
  if (product === undefined) return undefined;

  const priced: PricedItem[] = mine.map((item) => ({
    occurredOn: item.occurredOn,
    currency: item.currency,
    totalMinor: item.totalMinor,
    amount: amountOf(item.nameKey, item.quantity, product.unit),
  }));
  const order = byCurrency(ledger);
  return {
    ledger,
    ref: product.ref,
    name: product.name,
    unit: product.unit,
    months: monthLines(priced, product.unit).sort(
      (a, b) => b.month.localeCompare(a.month) || order(a, b),
    ),
    totals: totalLines(priced, product.unit).sort(order),
    reviewable: !resolved.sealed,
  };
}
