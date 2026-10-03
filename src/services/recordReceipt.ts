import { listActiveCategories } from '../db/categories.js';
import {
  findExpenseBySourceKey,
  insertExpenseOrGetExisting,
  type Expense,
  type ExpenseId,
} from '../db/expenses.js';
import { findActiveLedger, findLedgerForMember, type Ledger } from '../db/ledgers.js';
import {
  countReceiptsCreatedBy,
  findMerchantCategory,
  findReceiptByExpense,
  insertReceipt,
  type Receipt,
  type ReceiptId,
} from '../db/receipts.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import type { DecodedReceipt } from '../domain/receipts/types.js';
import { localDateOf, localDayWindow } from '../domain/time.js';
import { isSealedLedger, plaintext } from './ledgerKeys.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

export interface RecordReceiptInput {
  readonly user: User;
  readonly receipt: DecodedReceipt;
  // The description the expense carries until the shop's name is fetched («Чек»).
  readonly placeholder: string;
  // When the user sent it (the Telegram message date).
  readonly occurredAt: Date;
  readonly now: Date;
  // How many receipts the user may record per local day; absent for no cap (the admin).
  readonly dailyCap?: number | undefined;
}

// Each recorded receipt makes the worker call a tax site on the user's behalf (ADR-0018).
export const RECEIPTS_PER_DAY = 20;

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
  | { readonly kind: 'futureReceipt' }
  // The active ledger is sealed (ADR-0020): receipts aren't taken there, nothing is recorded.
  | { readonly kind: 'sealedLedger' }
  // The user already recorded `dailyCap` receipts on their local today: nothing is recorded.
  | { readonly kind: 'capReached' };

// Records a decoded receipt into the user's active ledger as one expense with the receipt's total
// and currency, dated the issue instant's local date, plus a `pending` receipt row the worker
// enriches later (ADR-0018). The source key carries the fiscal id and the ledger, so the same
// receipt sent again into the same ledger, as a photo or a link, returns the stored expense.
export function recordReceipt(deps: RecordDeps, input: RecordReceiptInput): RecordReceiptResult {
  const { db, logger } = deps;
  const { user, receipt } = input;

  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  if (isSealedLedger(deps, ledger.id)) return { kind: 'sealedLedger' };
  const sourceKey = `rcpt:${receipt.country}:${receipt.fiscalId}:${ledger.id}`;

  const seen = findExpenseBySourceKey(db, sourceKey);
  if (seen !== undefined) return duplicate(deps, user, plaintext(seen));

  const timezone = effectiveTimezone(deps, user, ledger);
  // After the duplicate lookup, which needs the decoded fiscal id: a receipt already recorded
  // answers as one even past the cap, and doesn't count toward it.
  if (input.dailyCap !== undefined) {
    const today = localDayWindow(localDateOf(input.now, timezone), timezone);
    if (countReceiptsCreatedBy(db, user.id, today) >= input.dailyCap) {
      logger.info({ userId: user.id }, 'daily receipt cap reached');
      return { kind: 'capReached' };
    }
  }
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
  if (!created) return duplicate(deps, user, plaintext(expense));

  const stored = findReceiptByExpense(db, expense.id);
  if (stored === undefined) throw new Error(`receipt of ${expense.id} vanished after insert`);
  logger.info(
    { receiptId: stored.id, expenseId: expense.id, country: receipt.country, userId: user.id },
    'receipt recorded',
  );
  return {
    kind: 'recorded',
    expense: plaintext(expense),
    ledger,
    receipt: stored,
    duplicate: false,
  };
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
