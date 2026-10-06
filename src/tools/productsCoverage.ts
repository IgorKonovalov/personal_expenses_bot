import type { Db } from '../db/connection.js';
import { listItemProducts } from '../db/itemProducts.js';
import type { LedgerId, LedgerKind } from '../db/ledgers.js';
import { listLedgerDatedItems } from '../db/receiptItems.js';
import { listUserProducts } from '../db/userProducts.js';
import type { UserId } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { formatMoney } from '../domain/money.js';
import { CATALOG } from '../domain/products/catalog.js';
import { matchProduct } from '../domain/products/match.js';
import { normalize } from '../domain/products/normalize.js';

// `pnpm products:coverage` (Plan 0036 Phase 5): how much of each ledger's receipt items the
// product rules and the users' answers (ADR-0039) claim, run by the user on a copy of the
// production database on their own machine. It only reads. A sealed ledger's items live in its
// encrypted rows, so only plaintext rows are counted.

export interface Share {
  readonly items: number;
  readonly spentMinor: number;
}

export interface LedgerCoverage {
  readonly ledgerId: LedgerId;
  readonly kind: LedgerKind;
  readonly currency: CurrencyCode;
  readonly rules: Share;
  readonly overrides: Share;
  readonly unmatched: Share;
}

export interface Coverage {
  // By ledger id, then currency.
  readonly ledgers: readonly LedgerCoverage[];
  // The most frequent unmatched normalized names over every ledger, most first, then by name.
  readonly topUnmatched: readonly { readonly nameKey: string; readonly items: number }[];
}

const TOP = 30;
const CATALOG_REFS = new Set(CATALOG.map((product) => `b:${product.key}`));

type Kind = 'rules' | 'overrides' | 'unmatched';

export function coverage(db: Db): Coverage {
  const answers = new Map<UserId, Map<string, string | null>>();
  const ownProducts = new Map<UserId, Set<string>>();
  // A name the author answered: a product that exists counts as an override match, and "not a
  // product" (or a product since gone) as unmatched. Any other name goes by the rules.
  const kindOf = (userId: UserId, nameKey: string): Kind => {
    let mine = answers.get(userId);
    if (mine === undefined) {
      mine = listItemProducts(db, userId);
      answers.set(userId, mine);
    }
    if (!mine.has(nameKey)) return matchProduct(nameKey) === undefined ? 'unmatched' : 'rules';
    let products = ownProducts.get(userId);
    if (products === undefined) {
      products = new Set(listUserProducts(db, userId).map((p) => `u:${p.id}`));
      ownProducts.set(userId, products);
    }
    const product = mine.get(nameKey) ?? null;
    return product !== null && (CATALOG_REFS.has(product) || products.has(product))
      ? 'overrides'
      : 'unmatched';
  };

  const ledgers: LedgerCoverage[] = [];
  const unmatchedNames = new Map<string, number>();
  const rows = db
    .prepare<[], { id: string; kind: LedgerKind }>('SELECT id, kind FROM ledgers ORDER BY id')
    .all();
  for (const row of rows) {
    const byCurrency = new Map<CurrencyCode, Record<Kind, { items: number; spentMinor: number }>>();
    for (const item of listLedgerDatedItems(db, row.id as LedgerId)) {
      const nameKey = normalize(item.name);
      const kind = kindOf(item.createdBy, nameKey);
      const shares = byCurrency.get(item.currency) ?? {
        rules: { items: 0, spentMinor: 0 },
        overrides: { items: 0, spentMinor: 0 },
        unmatched: { items: 0, spentMinor: 0 },
      };
      shares[kind].items += 1;
      shares[kind].spentMinor += item.totalMinor;
      byCurrency.set(item.currency, shares);
      if (kind === 'unmatched') unmatchedNames.set(nameKey, (unmatchedNames.get(nameKey) ?? 0) + 1);
    }
    for (const [currency, shares] of [...byCurrency].sort(([a], [b]) => a.localeCompare(b))) {
      ledgers.push({ ledgerId: row.id as LedgerId, kind: row.kind, currency, ...shares });
    }
  }
  const topUnmatched = [...unmatchedNames]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, TOP)
    .map(([nameKey, items]) => ({ nameKey, items }));
  return { ledgers, topUnmatched };
}

// `75.0%`: a share in tenths of a percent, rounded half up, in integers.
function percent(part: number, whole: number): string {
  if (whole === 0) return '0.0%';
  const tenths = Math.floor((part * 2000 + whole) / (whole * 2));
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

export function formatCoverage(report: Coverage): string {
  const lines: string[] = [];
  for (const ledger of report.ledgers) {
    const parts = [ledger.rules, ledger.overrides, ledger.unmatched];
    const items = parts.reduce((sum, share) => sum + share.items, 0);
    const spent = parts.reduce((sum, share) => sum + share.spentMinor, 0);
    const money = (amountMinor: number) => formatMoney({ amountMinor, currency: ledger.currency });
    const line = (pick: (share: Share) => number, total: number, show: (n: number) => string) =>
      (['rules', 'overrides', 'unmatched'] as const)
        .map(
          (kind) => `${kind} ${show(pick(ledger[kind]))} (${percent(pick(ledger[kind]), total)})`,
        )
        .join(', ');
    lines.push(`ledger ${ledger.kind} ${ledger.ledgerId} ${ledger.currency}`);
    lines.push(`  items: ${items}: ${line((s) => s.items, items, String)}`);
    lines.push(`  spend: ${money(spent)}: ${line((s) => s.spentMinor, spent, money)}`);
  }
  lines.push(`unmatched names, top ${TOP}:`);
  for (const { nameKey, items } of report.topUnmatched) lines.push(`  ${items}\t${nameKey}`);
  return lines.join('\n');
}
