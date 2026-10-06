import { isSealed, listLedgerExpenses } from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import { listLedgerDatedItems } from '../db/receiptItems.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { monthOf, previous } from '../domain/periods.js';
import { catalogProduct } from '../domain/products/catalog.js';
import { matchProduct } from '../domain/products/match.js';
import { normalize } from '../domain/products/normalize.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import {
  foldedReceipt,
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

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// `b:<catalog key>`: what a product travels as in callback data.
export type ProductRef = `b:${string}`;

interface ProductItem {
  readonly nameKey: string;
  readonly quantity: string;
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredOn: LocalDate;
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
}

export interface Spend {
  readonly currency: CurrencyCode;
  readonly spentMinor: number;
}

export interface MonthSpend extends Spend {
  // `YYYY-MM`.
  readonly month: string;
}

export interface ProductView {
  readonly ledger: Ledger;
  readonly ref: ProductRef;
  readonly name: string;
  // Newest month first; in a month, the default currency first, then by code.
  readonly months: readonly MonthSpend[];
  // All time, ordered as in a month.
  readonly totals: readonly Spend[];
}

function refOf(nameKey: string): ProductRef | undefined {
  const product = matchProduct(nameKey);
  return product === undefined ? undefined : `b:${product.key}`;
}

function nameOf(ref: ProductRef): string | undefined {
  return catalogProduct(ref.slice(2))?.name;
}

// The viewer's items in the ledger, oldest first, or `locked` for a sealed ledger without its key.
function ownItems(deps: Deps, user: User, ledger: Ledger): ProductItem[] | Locked {
  if (ledgerIsLocked(deps, ledger.id)) return LOCKED;
  const items: ProductItem[] = listLedgerDatedItems(deps.db, ledger.id)
    .filter((item) => item.createdBy === user.id)
    .map((item) => ({ ...item, nameKey: normalize(item.name) }));
  if (!isSealedLedger(deps, ledger.id)) return items;
  for (const row of listLedgerExpenses(deps.db, { ledgerId: ledger.id, memberId: user.id })) {
    if (!isSealed(row) || row.createdBy !== user.id) continue;
    const folded = foldedReceipt(deps, row.id);
    if (folded === undefined || folded.sellerName === null) continue;
    for (const item of folded.items) {
      items.push({
        nameKey: normalize(item.name),
        quantity: item.quantity,
        totalMinor: item.totalMinor,
        currency: row.currency,
        occurredOn: row.occurredOn,
      });
    }
  }
  return items;
}

// The first day of the month 11 months before today's: the start of "the last 12 months".
function recentFrom(deps: Deps, user: User, ledger: Ledger, now: Date): LocalDate {
  let month = monthOf(localDateOf(now, effectiveTimezone(deps, user, ledger)));
  for (let i = 0; i < 11; i++) month = previous(month);
  return month.from;
}

function listOf(deps: Deps, user: User, ledger: Ledger, now: Date): ProductList | Locked {
  const items = ownItems(deps, user, ledger);
  if (!Array.isArray(items)) return items;
  const from = recentFrom(deps, user, ledger, now);
  const recent = new Map<ProductRef, number>();
  for (const item of items) {
    const ref = refOf(item.nameKey);
    if (ref === undefined) continue;
    const counts = item.occurredOn >= from && item.currency === ledger.defaultCurrency;
    recent.set(ref, (recent.get(ref) ?? 0) + (counts ? item.totalMinor : 0));
  }
  const products = [...recent].flatMap(([ref, recentMinor]) => {
    const name = nameOf(ref);
    return name === undefined ? [] : [{ ref, name, recentMinor }];
  });
  products.sort((a, b) => b.recentMinor - a.recentMinor || a.name.localeCompare(b.name, 'ru'));
  return { ledger, products };
}

// /prices: the products of the user's active ledger.
export function activeProductList(deps: Deps, user: User, now: Date): ProductList | Locked {
  const ledger = findActiveLedger(deps.db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  return listOf(deps, user, ledger, now);
}

// A page of the list the screen was opened on. Undefined once the user is no longer a member.
export function ledgerProductList(
  deps: Deps,
  input: { readonly user: User; readonly ledgerId: LedgerId; readonly now: Date },
): ProductList | Locked | undefined {
  const ledger = findLedgerForMember(deps.db, input.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  return listOf(deps, input.user, ledger, input.now);
}

function byCurrency(ledger: Ledger) {
  const rank = (spend: Spend) => (spend.currency === ledger.defaultCurrency ? 0 : 1);
  return (a: Spend, b: Spend): number => rank(a) - rank(b) || a.currency.localeCompare(b.currency);
}

// One product of the screen's ledger. Undefined for a non-member, an unknown ref, or a product
// none of the user's items names any more.
export function ledgerProduct(
  deps: Deps,
  input: { readonly user: User; readonly ledgerId: LedgerId; readonly ref: string },
): ProductView | Locked | undefined {
  const ledger = findLedgerForMember(deps.db, input.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  const items = ownItems(deps, input.user, ledger);
  if (!Array.isArray(items)) return items;
  const ref = items.map((item) => refOf(item.nameKey)).find((r) => r === input.ref);
  const name = ref === undefined ? undefined : nameOf(ref);
  if (ref === undefined || name === undefined) return undefined;

  const months = new Map<string, MonthSpend>();
  const totals = new Map<CurrencyCode, Spend>();
  for (const item of items) {
    if (refOf(item.nameKey) !== ref) continue;
    const month = item.occurredOn.slice(0, 7);
    const key = `${month} ${item.currency}`;
    const spent = (months.get(key)?.spentMinor ?? 0) + item.totalMinor;
    months.set(key, { month, currency: item.currency, spentMinor: spent });
    const total = (totals.get(item.currency)?.spentMinor ?? 0) + item.totalMinor;
    totals.set(item.currency, { currency: item.currency, spentMinor: total });
  }
  const order = byCurrency(ledger);
  return {
    ledger,
    ref,
    name,
    months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month) || order(a, b)),
    totals: [...totals.values()].sort(order),
  };
}
