import { isSealed, listLedgerExpensesBetween, type ExpenseId } from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import { listFetchedReceiptItems } from '../db/receiptItems.js';
import type { User } from '../db/users.js';
import { groupItems, type ItemGroup, type PeriodItem } from '../domain/receipts/itemGroups.js';
import type { FetchedItem } from '../domain/receipts/types.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { foldedReceipt, openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// The receipt items of a period, grouped by category (ADR-0038). Only the viewer's own expenses
// count: a receipt's items are seen by its author alone, as on the card.

export interface PeriodItems {
  readonly ledger: Ledger;
  readonly groups: readonly ItemGroup[];
  // The viewer's expenses in the period with no fetched receipt behind them.
  readonly withoutReceipt: number;
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

interface Range {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

// A range of the ledger a summary screen was opened on. Undefined once the user is no longer a
// member, or for a range that starts after the ledger's today.
export function ledgerPeriodItems(
  deps: Deps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly range: Range;
    readonly now: Date;
  },
): PeriodItems | Locked | undefined {
  const ledger = findLedgerForMember(deps.db, input.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  return itemsOf(deps, input.user, ledger, input.range, input.now);
}

// A range of the user's active ledger at the moment of asking. Undefined for a range that starts
// after the ledger's today.
export function activePeriodItems(
  deps: Deps,
  input: { readonly user: User; readonly range: Range; readonly now: Date },
): PeriodItems | Locked | undefined {
  const ledger = findActiveLedger(deps.db, input.user.id);
  if (ledger === undefined) throw new Error(`user ${input.user.id} has no active ledger`);
  return itemsOf(deps, input.user, ledger, input.range, input.now);
}

// Expenses by their stored local occurred_on, never a UTC date. Plaintext rows read their items
// from receipt_items; a sealed row from the receipt folded into its payload (ADR-0020).
function itemsOf(
  deps: Deps,
  user: User,
  ledger: Ledger,
  range: Range,
  now: Date,
): PeriodItems | Locked | undefined {
  const { db } = deps;
  const today = localDateOf(now, effectiveTimezone(deps, user, ledger));
  if (range.from > today) return undefined;
  const rows = listLedgerExpensesBetween(db, {
    ledgerId: ledger.id,
    memberId: user.id,
    from: range.from,
    to: range.to,
  }).filter((row) => row.createdBy === user.id);
  const opened = openExpenses(deps, ledger.id, rows);
  if (opened.kind === 'locked') return opened;

  const sealedIds = new Set(rows.filter(isSealed).map((row) => row.id));
  const plaintextItems = new Map(
    listFetchedReceiptItems(
      db,
      rows.filter((row) => !sealedIds.has(row.id)).map((row) => row.id),
    ).map(({ expenseId, items }) => [expenseId, items]),
  );
  const itemsOfExpense = (
    id: ExpenseId,
  ): readonly (FetchedItem & { position?: number })[] | undefined => {
    if (!sealedIds.has(id)) return plaintextItems.get(id);
    const folded = foldedReceipt(deps, id);
    return folded === undefined || folded.sellerName === null ? undefined : folded.items;
  };

  const items: PeriodItem[] = [];
  let withoutReceipt = 0;
  for (const expense of opened.expenses) {
    const receiptItems = itemsOfExpense(expense.id);
    if (receiptItems === undefined) {
      withoutReceipt++;
      continue;
    }
    receiptItems.forEach((item, index) => {
      items.push({
        name: item.name,
        quantity: item.quantity,
        totalMinor: item.totalMinor,
        currency: expense.currency,
        occurredOn: expense.occurredOn,
        categoryId: expense.category?.id ?? null,
        categoryName: expense.category?.name ?? null,
        receiptKey: expense.id,
        position: item.position ?? index + 1,
      });
    });
  }
  return { ledger, groups: groupItems(items, ledger.defaultCurrency), withoutReceipt };
}
