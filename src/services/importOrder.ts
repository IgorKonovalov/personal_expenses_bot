import { listActiveCategories } from '../db/categories.js';
import {
  findExpenseById,
  insertExpenseOrGetExisting,
  type Expense,
  type ExpenseId,
} from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import {
  findMerchantCategory,
  findReceiptByOrderKey,
  insertOrderReceipt,
  type OrderReceipt,
  type ReceiptId,
} from '../db/receipts.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import type { PresetKey } from '../domain/categoryPresets.js';
import type { DeliveryOrder } from '../domain/orders/types.js';
import { deliveredInstant } from '../domain/orders/woltRs.js';
import { localDateOf } from '../domain/time.js';
import { isSealedLedger, plaintext } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';
import { stickyTagOf, withStickyTag } from './stickyTag.js';

// A delivery order read from its confirmation PDF (Plan 0051), recorded as one expense with the
// order's total, the restaurant as its description and the dishes as receipt items (ADR-0052).

// Where an order with no history from its seller goes, when the ledger has it.
const ORDER_PRESET: PresetKey = 'cafe';

export type ImportOrderResult =
  | {
      readonly kind: 'recorded';
      readonly expense: Expense;
      readonly ledger: Ledger;
      readonly receipt: OrderReceipt;
      // This order was already imported into this ledger: nothing new was written.
      readonly duplicate: boolean;
    }
  // The delivery's local date is after the local date the message was sent.
  | { readonly kind: 'futureOrder' }
  // The active ledger is sealed (ADR-0020): orders aren't taken there, nothing is recorded.
  | { readonly kind: 'sealedLedger' };

// One order per ledger, whether it created its expense or was attached to one (ADR-0052).
export function orderKey(order: DeliveryOrder, ledgerId: LedgerId): string {
  return `${order.source}:${order.orderId}:${ledgerId}`;
}

export function orderMerchantKey(order: DeliveryOrder): string {
  return `${order.source}:${order.sellerTaxId}`;
}

// Records the order into the user's active ledger, dated by the delivery instant's local date.
// The same order sent again into the same ledger returns the stored expense.
export function importOrder(
  deps: RecordDeps,
  input: {
    readonly user: User;
    readonly order: DeliveryOrder;
    // When the user sent the PDF (the Telegram message date).
    readonly sentAt: Date;
    readonly now: Date;
  },
): ImportOrderResult {
  const { db } = deps;
  const { user, order } = input;
  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  if (isSealedLedger(deps, ledger.id)) return { kind: 'sealedLedger' };

  const key = orderKey(order, ledger.id);
  const seen = findReceiptByOrderKey(db, key);
  if (seen !== undefined) return duplicate(deps, user, seen);

  const timezone = effectiveTimezone(deps, user, ledger);
  const deliveredAt = deliveredInstant(order.deliveredAt);
  const deliveredOn = localDateOf(deliveredAt, timezone);
  if (deliveredOn > localDateOf(input.sentAt, timezone)) return { kind: 'futureOrder' };

  const merchantKey = orderMerchantKey(order);
  const categories = listActiveCategories(db, ledger.id);
  // The seller's history, else the cafe preset, else the fallback.
  const category = suggestCategory({
    description: '',
    categories,
    historyCategoryId:
      findMerchantCategory(db, ledger.id, merchantKey) ??
      categories.find((c) => c.presetKey === ORDER_PRESET)?.id,
  });
  const { expense, created } = db.transaction(() => {
    const stored = insertExpenseOrGetExisting(db, {
      id: deps.newId() as ExpenseId,
      ledgerId: ledger.id,
      createdBy: user.id,
      amountMinor: order.totalMinor,
      currency: order.currency,
      description: order.restaurant,
      occurredAt: deliveredAt,
      occurredOn: deliveredOn,
      sourceKey: `order:${key}`,
      createdAt: input.now,
      categoryId: category.id,
      descriptionKey: descriptionKey(order.restaurant),
      tags: withStickyTag([], stickyTagOf(deps, ledger.id, user.id)),
    });
    if (stored.created) attachOrder(deps, stored.expense.id, order, key, input.now);
    return stored;
  })();
  const receipt = findReceiptByOrderKey(db, key);
  if (receipt === undefined) throw new Error(`order receipt of ${expense.id} vanished`);
  if (!created) return duplicate(deps, user, receipt);
  deps.logger.info(
    { receiptId: receipt.id, expenseId: expense.id, items: order.items.length, userId: user.id },
    'order recorded',
  );
  return { kind: 'recorded', expense: plaintext(expense), ledger, receipt, duplicate: false };
}

// The order's receipt row and items under `expenseId`. Run it in the caller's transaction.
export function attachOrder(
  deps: Pick<RecordDeps, 'db' | 'newId'>,
  expenseId: ExpenseId,
  order: DeliveryOrder,
  key: string,
  now: Date,
): void {
  const receiptId = deps.newId() as ReceiptId;
  insertOrderReceipt(deps.db, {
    id: receiptId,
    expenseId,
    orderKey: key,
    merchantKey: orderMerchantKey(order),
    issuedAt: deliveredInstant(order.deliveredAt),
    sellerName: order.restaurant,
    createdAt: now,
  });
  insertReceiptItems(deps.db, receiptId, order.items);
}

function duplicate(deps: RecordDeps, user: User, receipt: OrderReceipt): ImportOrderResult {
  const stored = findExpenseById(deps.db, receipt.expenseId);
  if (stored === undefined) throw new Error(`order receipt ${receipt.id} lost its expense`);
  const expense = plaintext(stored);
  const ledger = findLedgerForMember(deps.db, expense.ledgerId, user.id);
  if (ledger === undefined) throw new Error(`order key reused across ledgers (${expense.id})`);
  deps.logger.info(
    { receiptId: receipt.id, expenseId: expense.id, userId: user.id },
    'duplicate order',
  );
  return { kind: 'recorded', expense, ledger, receipt, duplicate: true };
}
