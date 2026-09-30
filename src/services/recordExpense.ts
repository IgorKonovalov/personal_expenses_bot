import { listActiveCategories } from '../db/categories.js';
import {
  findExpenseById,
  findExpenseBySourceKey,
  findHistoryCategory,
  insertExpenseOrGetExisting,
  restoreDeletedExpense,
  softDeleteExpense,
  type Expense,
  type ExpenseId,
} from '../db/expenses.js';
import { findActiveLedger, findLedgerForMember, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText, type ExpenseTextResult } from '../domain/expenseText.js';
import type { AmountReading } from '../domain/money.js';
import { localDateOf } from '../domain/time.js';
import type { Logger } from '../logger.js';
import type { ServiceDeps } from './provisionUser.js';

export interface RecordDeps extends ServiceDeps {
  readonly logger: Logger;
}

export interface RecordExpenseInput {
  readonly user: User;
  readonly text: string;
  // Opaque dedupe key built by the adapter, e.g. `tg:<chat_id>:<message_id>`.
  readonly sourceKey: string;
  // When the user sent it (the Telegram message date), not when it is processed.
  readonly occurredAt: Date;
  readonly now: Date;
  // The user's answer to an ambiguous amount: records that reading of the same text.
  readonly reading?: AmountReading['interpretation'];
}

export type RecordExpenseResult =
  | {
      readonly kind: 'recorded';
      readonly expense: Expense;
      readonly ledger: Ledger;
      readonly duplicate: boolean;
    }
  | {
      readonly kind: 'ambiguous';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
      readonly description: string;
      readonly ledger: Ledger;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'notExpense' }
  // A reading was chosen, but the text no longer offers it.
  | { readonly kind: 'readingUnavailable' };

// Records free text into the user's active ledger, in the category suggestCategory picks
// (ADR-0008). A source key seen before returns the
// stored expense unchanged, so a redelivered update, or a second tap on a reading, records
// nothing new.
export function recordExpense(deps: RecordDeps, input: RecordExpenseInput): RecordExpenseResult {
  const { db, logger } = deps;
  const { user } = input;

  const seen = findExpenseBySourceKey(db, input.sourceKey);
  if (seen !== undefined) {
    const ledger = findLedgerForMember(db, seen.ledgerId, user.id);
    if (ledger === undefined) throw new Error(`source key reused across users (${seen.id})`);
    logger.info({ expenseId: seen.id, userId: user.id }, 'duplicate expense delivery');
    return { kind: 'recorded', expense: seen, ledger, duplicate: true };
  }

  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);

  const parsed = resolveReading(
    parseExpenseText(input.text, ledger.defaultCurrency),
    input.reading,
  );
  if (parsed.kind === 'ambiguous') return { ...parsed, ledger };
  if (parsed.kind !== 'expense') return parsed;

  const key = descriptionKey(parsed.description);
  const category = suggestCategory({
    description: parsed.description,
    categories: listActiveCategories(db, ledger.id),
    historyCategoryId: findHistoryCategory(db, ledger.id, key),
  });
  const { expense, created } = insertExpenseOrGetExisting(db, {
    id: newExpenseId(deps),
    ledgerId: ledger.id,
    createdBy: user.id,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    description: parsed.description,
    occurredAt: input.occurredAt,
    occurredOn: localDateOf(input.occurredAt, user.timezone),
    sourceKey: input.sourceKey,
    createdAt: input.now,
    categoryId: category.id,
    descriptionKey: key,
  });
  logger.info(
    { expenseId: expense.id, ledgerId: ledger.id, userId: user.id, duplicate: !created },
    'expense recorded',
  );
  return { kind: 'recorded', expense, ledger, duplicate: !created };
}

// Without a chosen reading the parse stands, so an ambiguous amount stays a question. With one,
// only an ambiguous parse that still offers that reading becomes an expense.
function resolveReading(
  parsed: ExpenseTextResult,
  reading: AmountReading['interpretation'] | undefined,
): ExpenseTextResult | { readonly kind: 'readingUnavailable' } {
  if (reading === undefined) return parsed;
  if (parsed.kind !== 'ambiguous') return { kind: 'readingUnavailable' };
  const chosen = parsed.readings.find((r) => r.interpretation === reading);
  if (chosen === undefined) return { kind: 'readingUnavailable' };
  return {
    kind: 'expense',
    amountMinor: chosen.amountMinor,
    currency: parsed.currency,
    description: parsed.description,
  };
}

export type UndoExpenseResult =
  | { readonly kind: 'undone'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'alreadyUndone' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' };

// Soft-deletes an expense. Only its creator may undo it; a repeat leaves deleted_at unchanged.
export function undoExpense(
  deps: RecordDeps,
  input: { readonly user: User; readonly expenseId: ExpenseId; readonly now: Date },
): UndoExpenseResult {
  const { db, logger } = deps;
  const expense = findExpenseById(db, input.expenseId);
  if (expense === undefined) return { kind: 'notFound' };
  if (expense.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, expense.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (!softDeleteExpense(db, expense.id, input.now)) return { kind: 'alreadyUndone' };
  logger.info({ expenseId: expense.id, userId: input.user.id }, 'expense undone');
  return { kind: 'undone', expense, ledger };
}

export type RestoreExpenseResult =
  | { readonly kind: 'restored'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'alreadyRestored' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' };

// Clears deleted_at. Only the creator may restore; compare-and-set on deleted_at IS NOT NULL,
// so a repeat changes nothing.
export function restoreExpense(
  deps: RecordDeps,
  input: { readonly user: User; readonly expenseId: ExpenseId },
): RestoreExpenseResult {
  const { db, logger } = deps;
  const expense = findExpenseById(db, input.expenseId);
  if (expense === undefined) return { kind: 'notFound' };
  if (expense.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, expense.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (!restoreDeletedExpense(db, expense.id)) return { kind: 'alreadyRestored' };
  logger.info({ expenseId: expense.id, userId: input.user.id }, 'expense restored');
  return { kind: 'restored', expense: { ...expense, deletedAt: null }, ledger };
}

// The expense a source message recorded, deleted or not. Read-only.
export function findExpenseForSource(
  { db }: Pick<ServiceDeps, 'db'>,
  sourceKey: string,
): Expense | undefined {
  return findExpenseBySourceKey(db, sourceKey);
}

function newExpenseId({ newId }: ServiceDeps): ExpenseId {
  return newId() as ExpenseId;
}
