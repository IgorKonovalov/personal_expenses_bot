import { listActiveCategories } from '../db/categories.js';
import {
  findExpenseBySourceKey,
  insertExpenseOrGetExisting,
  type Expense,
  type ExpenseId,
} from '../db/expenses.js';
import { findActiveLedger, findLedgerForMember, type Ledger } from '../db/ledgers.js';
import {
  findMerchantCategory,
  findReceiptByExpense,
  insertReceipt,
  type Receipt,
  type ReceiptId,
} from '../db/receipts.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import type { DecodedReceipt } from '../domain/receipts/types.js';
import { localDateOf } from '../domain/time.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

export interface RecordReceiptInput {
  readonly user: User;
  readonly receipt: DecodedReceipt;
  // The description the expense carries until the shop's name is fetched («Чек»).
  readonly placeholder: string;
  // When the user sent it (the Telegram message date).
  readonly occurredAt: Date;
  readonly now: Date;
}

export type RecordReceiptResult =
  | {
      readonly kind: 'recorded';
      readonly expense: Expense;
      readonly ledger: Ledger;
      readonly receipt: Receipt;
      // The same receipt was already recorded into this ledger: nothing new was written.
      readonly duplicate: boolean;
    }
  // The receipt's local issue date is after the local date the message was sent.
  | { readonly kind: 'futureReceipt' };

// Records a decoded receipt into the user's active ledger as one expense with the receipt's total
// and currency, dated the issue instant's local date, plus a `pending` receipt row the worker
// enriches later (ADR-0018). The source key carries the fiscal id and the ledger, so the same
// receipt sent again into the same ledger, as a photo or a link, returns the stored expense.
export function recordReceipt(deps: RecordDeps, input: RecordReceiptInput): RecordReceiptResult {
  const { db, logger } = deps;
  const { user, receipt } = input;

  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  const sourceKey = `rcpt:${receipt.country}:${receipt.fiscalId}:${ledger.id}`;

  const seen = findExpenseBySourceKey(db, sourceKey);
  if (seen !== undefined) return duplicate(deps, user, seen);

  const timezone = effectiveTimezone(deps, user, ledger);
  const sentOn = localDateOf(input.occurredAt, timezone);
  const issuedOn = localDateOf(receipt.issuedAt, timezone);
  if (issuedOn > sentOn) return { kind: 'futureReceipt' };

  const category = suggestCategory({
    description: input.placeholder,
    categories: listActiveCategories(db, ledger.id),
    historyCategoryId: findMerchantCategory(db, ledger.id, receipt.merchantKey),
  });
  const receiptId = deps.newId() as ReceiptId;
  const { expense, created } = db.transaction(() => {
    const stored = insertExpenseOrGetExisting(db, {
      id: deps.newId() as ExpenseId,
      ledgerId: ledger.id,
      createdBy: user.id,
      amountMinor: receipt.totalMinor,
      currency: receipt.currency,
      description: input.placeholder,
      occurredAt: input.occurredAt,
      occurredOn: issuedOn,
      sourceKey,
      createdAt: input.now,
      categoryId: category.id,
      descriptionKey: descriptionKey(input.placeholder),
    });
    if (stored.created) {
      insertReceipt(db, {
        id: receiptId,
        expenseId: stored.expense.id,
        country: receipt.country,
        fiscalId: receipt.fiscalId,
        merchantKey: receipt.merchantKey,
        verifyUrl: receipt.verifyUrl,
        issuedAt: receipt.issuedAt,
        createdAt: input.now,
      });
    }
    return stored;
  })();
  if (!created) return duplicate(deps, user, expense);

  const stored = findReceiptByExpense(db, expense.id);
  if (stored === undefined) throw new Error(`receipt of ${expense.id} vanished after insert`);
  logger.info(
    { receiptId: stored.id, expenseId: expense.id, country: receipt.country, userId: user.id },
    'receipt recorded',
  );
  return { kind: 'recorded', expense, ledger, receipt: stored, duplicate: false };
}

function duplicate(deps: RecordDeps, user: User, expense: Expense): RecordReceiptResult {
  const ledger = findLedgerForMember(deps.db, expense.ledgerId, user.id);
  if (ledger === undefined)
    throw new Error(`receipt source key reused across users (${expense.id})`);
  const receipt = findReceiptByExpense(deps.db, expense.id);
  if (receipt === undefined) throw new Error(`receipt expense ${expense.id} has no receipt`);
  deps.logger.info(
    { receiptId: receipt.id, expenseId: expense.id, country: receipt.country, userId: user.id },
    'duplicate receipt',
  );
  return { kind: 'recorded', expense, ledger, receipt, duplicate: true };
}
