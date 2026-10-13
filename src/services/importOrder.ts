import { listActiveCategories } from '../db/categories.js';
import {
  findExpenseById,
  insertExpenseOrGetExisting,
  listLedgerExpensesBetween,
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
  findReceiptByExpense,
  findReceiptByOrderKey,
  insertOrderReceipt,
  type OrderReceipt,
  type ReceiptId,
} from '../db/receipts.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import type { PresetKey } from '../domain/categoryPresets.js';
import { addDays } from '../domain/dateText.js';
import type { DeliveryOrder } from '../domain/orders/types.js';
import { deliveredInstant } from '../domain/orders/woltRs.js';
import { matchRows } from '../domain/statements/match.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { cancelFlow, pendingOrderFlow, startOrderFlow } from './flowSessions.js';
import { isSealedLedger, plaintext } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';
import { stickyTagOf, withStickyTag } from './stickyTag.js';

// A delivery order read from its confirmation PDF (Plan 0051), recorded as one expense with the
// order's total, the restaurant as its description and the dishes as receipt items (ADR-0052).
// When one of the user's own live expenses already matches it by ADR-0032's rule, the order is
// held in a flow session and the user is asked whether that expense is the order.

// Where an order with no history from its seller goes, when the ledger has it.
const ORDER_PRESET: PresetKey = 'cafe';

export interface OrderRecorded {
  readonly kind: 'recorded';
  readonly expense: Expense;
  readonly ledger: Ledger;
  readonly receipt: OrderReceipt;
  // This order was already imported into this ledger: nothing new was written.
  readonly duplicate: boolean;
}

// Why an order records nothing.
export type OrderRefusal =
  // The delivery's local date is after the local date the message was sent.
  | { readonly kind: 'futureOrder' }
  // The ledger is sealed (ADR-0020): orders aren't taken there, nothing is recorded.
  | { readonly kind: 'sealedLedger' };

export type ImportOrderResult =
  | OrderRecorded
  | OrderRefusal
  // A live expense of the user matches the order: it is held, and nothing is recorded yet.
  | { readonly kind: 'asked'; readonly candidate: Expense; readonly ledger: Ledger };

// One order per ledger, whether it created its expense or was attached to one (ADR-0052).
export function orderKey(order: DeliveryOrder, ledgerId: LedgerId): string {
  return `${order.source}:${order.orderId}:${ledgerId}`;
}

export function orderMerchantKey(order: DeliveryOrder): string {
  return `${order.source}:${order.sellerTaxId}`;
}

// Imports the order into the user's active ledger, dated by the delivery instant's local date.
// The same order sent again into the same ledger returns the stored expense, even when it was
// attached to an existing one; a match asks first.
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

  const seen = findReceiptByOrderKey(db, orderKey(order, ledger.id));
  if (seen !== undefined) return duplicate(deps, user, seen);

  const timezone = effectiveTimezone(deps, user, ledger);
  const deliveredOn = localDateOf(deliveredInstant(order.deliveredAt), timezone);
  if (deliveredOn > localDateOf(input.sentAt, timezone)) return { kind: 'futureOrder' };

  const candidate = findCandidate(deps, user, ledger.id, order, deliveredOn);
  if (candidate === undefined) return recordOrder(deps, user, ledger, order, input.now);
  startOrderFlow(
    deps,
    user,
    { ledgerId: ledger.id, order, candidateExpenseId: candidate.id },
    input.now,
  );
  deps.logger.info({ expenseId: candidate.id, userId: user.id }, 'order matched');
  return { kind: 'asked', candidate, ledger };
}

// ADR-0032's match, one row against the user's own live expenses: the same amount and currency,
// occurred_on within a day of the delivery's local date.
function findCandidate(
  deps: RecordDeps,
  user: User,
  ledgerId: LedgerId,
  order: DeliveryOrder,
  deliveredOn: LocalDate,
): Expense | undefined {
  const own = listLedgerExpensesBetween(deps.db, {
    ledgerId,
    memberId: user.id,
    from: addDays(deliveredOn, -1),
    to: addDays(deliveredOn, 1),
  })
    .filter((expense) => expense.createdBy === user.id)
    .map(plaintext);
  const [id] = matchRows(
    [{ date: deliveredOn, amountMinor: order.totalMinor, currency: order.currency }],
    own,
  );
  return own.find((expense) => expense.id === id);
}

// Records the order as a new expense in `ledger`, with its receipt row and items, in one
// transaction. The source key carries the order key, so a race records once.
function recordOrder(
  deps: RecordDeps,
  user: User,
  ledger: Ledger,
  order: DeliveryOrder,
  now: Date,
): OrderRecorded {
  const { db } = deps;
  const key = orderKey(order, ledger.id);
  const deliveredAt = deliveredInstant(order.deliveredAt);
  const timezone = effectiveTimezone(deps, user, ledger);
  const categories = listActiveCategories(db, ledger.id);
  // The seller's history, else the cafe preset, else the fallback.
  const category = suggestCategory({
    description: '',
    categories,
    historyCategoryId:
      findMerchantCategory(db, ledger.id, orderMerchantKey(order)) ??
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
      occurredOn: localDateOf(deliveredAt, timezone),
      sourceKey: `order:${key}`,
      createdAt: now,
      categoryId: category.id,
      descriptionKey: descriptionKey(order.restaurant),
      tags: withStickyTag([], stickyTagOf(deps, ledger.id, user.id)),
    });
    if (stored.created) attachOrder(deps, stored.expense.id, order, key, now);
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
function attachOrder(
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

function duplicate(deps: RecordDeps, user: User, receipt: OrderReceipt): OrderRecorded {
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

export type AnswerOrderResult =
  // No order is pending: it expired, was answered or cancelled, or another flow replaced it.
  | { readonly kind: 'expired' }
  | { readonly kind: 'sealedLedger' }
  // [Да]: the dishes now sit on the candidate, whose amount, text and category are untouched.
  | {
      readonly kind: 'attached';
      readonly expense: Expense;
      readonly ledger: Ledger;
      readonly receipt: OrderReceipt;
    }
  // [Да] on a candidate that has a receipt already: nothing was written.
  | { readonly kind: 'hasItems'; readonly expense: Expense; readonly ledger: Ledger }
  // [Нет], or [Да] on a candidate deleted meanwhile (`candidateGone`): recorded as a new expense.
  | (OrderRecorded & { readonly candidateGone: boolean });

// [Да, это он] (`same`) or [Нет, записать отдельно] (`new`) on the pending order. The flow is
// cleared and the candidate re-read in one transaction, so a second tap finds nothing pending and
// writes nothing.
export function answerOrder(
  deps: RecordDeps,
  input: { readonly user: User; readonly answer: 'same' | 'new'; readonly now: Date },
): AnswerOrderResult {
  const { db } = deps;
  const { user, now } = input;
  return db.transaction((): AnswerOrderResult => {
    const flow = pendingOrderFlow(deps, user, now);
    if (flow === undefined) return { kind: 'expired' };
    cancelFlow(deps, user);
    const ledger = findLedgerForMember(db, flow.ledgerId, user.id);
    if (ledger === undefined) return { kind: 'expired' };
    if (isSealedLedger(deps, ledger.id)) return { kind: 'sealedLedger' };
    const key = orderKey(flow.order, ledger.id);
    const seen = findReceiptByOrderKey(db, key);
    if (seen !== undefined) return { ...duplicate(deps, user, seen), candidateGone: false };
    if (input.answer === 'new') {
      return { ...recordOrder(deps, user, ledger, flow.order, now), candidateGone: false };
    }

    const stored = findExpenseById(db, flow.candidateExpenseId);
    if (stored === undefined || stored.deletedAt !== null || stored.ledgerId !== ledger.id) {
      return { ...recordOrder(deps, user, ledger, flow.order, now), candidateGone: true };
    }
    const candidate = plaintext(stored);
    if (findReceiptByExpense(db, candidate.id) !== undefined) {
      return { kind: 'hasItems', expense: candidate, ledger };
    }
    attachOrder(deps, candidate.id, flow.order, key, now);
    const receipt = findReceiptByOrderKey(db, key);
    if (receipt === undefined) throw new Error(`attached order of ${candidate.id} vanished`);
    deps.logger.info(
      { receiptId: receipt.id, expenseId: candidate.id, userId: user.id },
      'order attached',
    );
    return { kind: 'attached', expense: candidate, ledger, receipt };
  })();
}

// [Отмена]: drops the pending order. Returns false when none was pending.
export function cancelOrder(
  deps: RecordDeps,
  input: { readonly user: User; readonly now: Date },
): boolean {
  if (pendingOrderFlow(deps, input.user, input.now) === undefined) return false;
  return cancelFlow(deps, input.user);
}
