import { listActiveCategories } from '../db/categories.js';
import { findExpenseBySourceKey, type Expense, type ExpenseId } from '../db/expenses.js';
import { findActiveLedger, findLedgerForMember, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import type { BankSmsPurchase } from '../domain/bankSms/types.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import { localDateOf } from '../domain/time.js';
import { isLocked, isSealedLedger, openExpense, type KeyDeps } from './ledgerKeys.js';
import {
  effectiveTimezone,
  historyCategory,
  storeExpense,
  type RecordDeps,
} from './recordExpense.js';
import { stickyTagOf, withStickyTag } from './stickyTag.js';

export interface RecordBankSmsInput {
  readonly user: User;
  readonly sms: BankSmsPurchase;
  // The Telegram message's key (`tg:<chat>:<message>`): a sealed ledger's source key.
  readonly messageKey: string;
  // When the user sent it (the Telegram message date).
  readonly occurredAt: Date;
  readonly now: Date;
}

export type RecordBankSmsResult =
  | {
      readonly kind: 'recorded';
      readonly expense: Expense;
      readonly ledger: Ledger;
      // The same SMS was already recorded into this ledger: nothing new was written.
      readonly duplicate: boolean;
    }
  // The SMS's local purchase date is after the local date the message was sent.
  | { readonly kind: 'futureSms' }
  // Already recorded into a sealed ledger that is locked (ADR-0020): nothing can be shown.
  | { readonly kind: 'sealedDuplicate' };

// Records a bank SMS purchase into the user's active ledger as one ordinary expense in the
// charged amount and currency, dated the purchase instant's local date (ADR-0021). In a plaintext
// ledger the source key carries the SMS's content fingerprint and the ledger, so the same SMS
// pasted again into the same ledger returns the stored expense. A sealed ledger gets a sealed row
// keyed by the message, which carries no content (ADR-0020): a redelivered update returns the
// stored expense, and the same SMS pasted in a new message records a second one.
export function recordBankSms(
  deps: RecordDeps & Pick<KeyDeps, 'keys'>,
  input: RecordBankSmsInput,
): RecordBankSmsResult {
  const { db, logger } = deps;
  const { user, sms } = input;

  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  const sourceKey = isSealedLedger(deps, ledger.id)
    ? input.messageKey
    : `sms:${sms.template}:${sms.fingerprint}:${ledger.id}`;

  const seen = findExpenseBySourceKey(db, sourceKey);
  if (seen !== undefined) {
    const expense = openExpense(deps, seen);
    if (isLocked(expense)) return { kind: 'sealedDuplicate' };
    return duplicate(deps, user, expense, sms);
  }

  const timezone = effectiveTimezone(deps, user, ledger);
  const purchasedOn = localDateOf(sms.issuedAt, timezone);
  if (purchasedOn > localDateOf(input.occurredAt, timezone)) return { kind: 'futureSms' };

  const key = descriptionKey(sms.description);
  const category = suggestCategory({
    description: sms.description,
    categories: listActiveCategories(db, ledger.id),
    historyCategoryId: historyCategory(deps, ledger.id, key),
  });
  const stored = storeExpense(deps, {
    id: deps.newId() as ExpenseId,
    ledgerId: ledger.id,
    createdBy: user.id,
    amountMinor: sms.amountMinor,
    currency: sms.currency,
    description: sms.description,
    occurredAt: input.occurredAt,
    occurredOn: purchasedOn,
    sourceKey,
    createdAt: input.now,
    category: { id: category.id, name: category.name },
    descriptionKey: key,
    tags: withStickyTag([], stickyTagOf(deps, ledger.id, user.id)),
  });
  if (stored.kind === 'sealedDuplicate') return stored;
  const { expense, created } = stored;
  if (!created) return duplicate(deps, user, expense, sms);

  logger.info(
    { expenseId: expense.id, userId: user.id, template: sms.template },
    'bank sms recorded',
  );
  return { kind: 'recorded', expense, ledger, duplicate: false };
}

function duplicate(
  deps: RecordDeps,
  user: User,
  expense: Expense,
  sms: BankSmsPurchase,
): RecordBankSmsResult {
  const ledger = findLedgerForMember(deps.db, expense.ledgerId, user.id);
  if (ledger === undefined)
    throw new Error(`bank sms source key reused across users (${expense.id})`);
  deps.logger.info(
    { expenseId: expense.id, userId: user.id, template: sms.template },
    'duplicate bank sms',
  );
  return { kind: 'recorded', expense, ledger, duplicate: true };
}
