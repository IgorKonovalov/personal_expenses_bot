import { listActiveCategories } from '../db/categories.js';
import { findExpenseById, findHistoryCategory, type Expense } from '../db/expenses.js';
import { findLedgerForMember, type Ledger } from '../db/ledgers.js';
import { insertReceiptItems } from '../db/receiptItems.js';
import {
  fillReceiptCategory,
  fillReceiptDescription,
  findDueReceipt,
  findReceiptAuthor,
  findReceiptById,
  findReceiptExpenseState,
  markReceiptFetched,
  recordReceiptFailure,
  setReceiptCard,
  type Receipt,
  type ReceiptId,
} from '../db/receipts.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import { FALLBACK_PRESET } from '../domain/categoryPresets.js';
import type { FetchedReceipt, ReceiptCountry } from '../domain/receipts/types.js';
import type { RecordDeps } from './recordExpense.js';

// Why a fetch failed. `error` is a fetcher that threw instead of answering.
export type FetchFailure = 'timeout' | 'network' | 'http' | 'empty' | 'unparseable' | 'error';

export type FetchOutcome =
  | { readonly kind: 'fetched'; readonly receipt: FetchedReceipt }
  | { readonly kind: 'failed'; readonly reason: FetchFailure };

// A per-country adapter over the tax site. It must settle once `signal` aborts.
export type ReceiptFetcher = (
  receipt: Pick<Receipt, 'verifyUrl' | 'fiscalId'>,
  signal: AbortSignal,
) => Promise<FetchOutcome>;

export interface FetchDeps extends RecordDeps {
  readonly fetchers: Readonly<Record<ReceiptCountry, ReceiptFetcher>>;
  // The description a receipt expense carries until its shop is known.
  readonly placeholder: string;
}

// After failed attempts 1 to 5; the sixth failure marks the receipt `failed` (ADR-0018). The
// attempts land at t0, +1 min, +6 min, +36 min, +2 h 36 min and +14 h 36 min.
const MINUTE = 60_000;
const RETRY_DELAYS_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 720 * MINUTE];
export const MAX_FETCH_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export type FetchDueResult =
  // Nothing is due.
  | { readonly kind: 'idle' }
  // The receipt is `fetched` or `failed` now: its card can show it.
  | {
      readonly kind: 'settled';
      readonly receipt: Receipt;
      readonly expense: Expense;
      readonly ledger: Ledger;
      readonly author: User;
    }
  // The attempt failed and another is scheduled, or another fetch settled the receipt first.
  | { readonly kind: 'pending' };

// Fetches the receipt due earliest, one per call. Success stores the items, the seller name and
// `fetched` in one transaction that is compare-and-set on `pending`, so a receipt fetched twice
// (a restart mid-fetch) gets its items once. The placeholder description and a fallback category
// are replaced only while the user hasn't changed them. Failure reschedules with backoff.
export async function fetchDueReceipt(
  deps: FetchDeps,
  input: { readonly now: Date; readonly signal: AbortSignal },
): Promise<FetchDueResult> {
  const { db } = deps;
  const receipt = findDueReceipt(db, input.now);
  if (receipt === undefined) return { kind: 'idle' };

  const outcome = await runFetcher(deps, receipt, input.signal);
  if (outcome.kind === 'failed') return failed(deps, receipt, outcome.reason, input.now);
  const fetched = outcome.receipt;
  const applied = db.transaction(() => {
    if (!markReceiptFetched(db, receipt.id, fetched.sellerName)) return false;
    insertReceiptItems(db, receipt.id, fetched.items);
    enrichExpense(deps, receipt, fetched.sellerName);
    return true;
  })();
  if (!applied) return { kind: 'pending' };
  deps.logger.info(
    { receiptId: receipt.id, country: receipt.country, items: fetched.items.length },
    'receipt fetched',
  );
  const result = settled(deps, receipt.id);
  if (result.kind === 'settled') warnOnMismatch(deps, result, fetched);
  return result;
}

async function runFetcher(
  deps: FetchDeps,
  receipt: Receipt,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  try {
    return await deps.fetchers[receipt.country](receipt, signal);
  } catch {
    return { kind: 'failed', reason: 'error' };
  }
}

function enrichExpense(deps: FetchDeps, receipt: Receipt, sellerName: string): void {
  const { db } = deps;
  // A user who changed either field has taken the expense over: the worker leaves it alone.
  const state = findReceiptExpenseState(db, receipt.expenseId, deps.placeholder);
  if (state === undefined || !state.descriptionUntouched || !state.categoryUntouched) return;
  const key = descriptionKey(sellerName);
  // Suggested before the description moves: the history step would otherwise find this very
  // expense under the seller's key, still in the fallback.
  const expense = findExpenseById(db, receipt.expenseId);
  if (expense !== undefined && state.categoryPresetKey === FALLBACK_PRESET) {
    const category = suggestCategory({
      description: sellerName,
      categories: listActiveCategories(db, expense.ledgerId),
      historyCategoryId: findHistoryCategory(db, expense.ledgerId, key),
    });
    if (category.id !== expense.category?.id) fillReceiptCategory(db, expense.id, category.id);
  }
  fillReceiptDescription(db, receipt.expenseId, {
    placeholder: deps.placeholder,
    description: sellerName,
    descriptionKey: key,
  });
}

// The QR total stays the expense amount; a site that disagrees is only logged, by id.
function warnOnMismatch(
  { logger }: FetchDeps,
  { receipt, expense }: { readonly receipt: Receipt; readonly expense: Expense },
  fetched: FetchedReceipt,
): void {
  if (fetched.totalMinor !== expense.amountMinor) {
    logger.warn({ receiptId: receipt.id }, 'fetched receipt total differs from the QR total');
  }
  if (fetched.currencyCode !== undefined && fetched.currencyCode !== expense.currency) {
    logger.warn({ receiptId: receipt.id }, 'fetched receipt currency differs from the QR currency');
  }
}

function failed(
  deps: FetchDeps,
  receipt: Receipt,
  reason: FetchFailure,
  now: Date,
): FetchDueResult {
  const attempts = receipt.attempts + 1;
  const delay = RETRY_DELAYS_MS[attempts - 1];
  const nextFetchAt =
    attempts >= MAX_FETCH_ATTEMPTS || delay === undefined ? null : new Date(now.getTime() + delay);
  if (!recordReceiptFailure(deps.db, receipt.id, { fromAttempts: receipt.attempts, nextFetchAt })) {
    return { kind: 'pending' };
  }
  deps.logger.info(
    {
      receiptId: receipt.id,
      country: receipt.country,
      attempts,
      reason,
      gaveUp: nextFetchAt === null,
    },
    'receipt fetch failed',
  );
  return nextFetchAt === null ? settled(deps, receipt.id) : { kind: 'pending' };
}

function settled(deps: FetchDeps, receiptId: ReceiptId): FetchDueResult {
  const { db } = deps;
  const receipt = findReceiptById(db, receiptId);
  const expense = receipt === undefined ? undefined : findExpenseById(db, receipt.expenseId);
  const author = expense === undefined ? undefined : findReceiptAuthor(db, expense.id);
  const ledger =
    expense === undefined || author === undefined
      ? undefined
      : findLedgerForMember(db, expense.ledgerId, author.id);
  if (receipt === undefined || expense === undefined || author === undefined) {
    throw new Error(`receipt ${receiptId} lost its expense`);
  }
  // An author who left a shared ledger: nothing to show them.
  if (ledger === undefined) return { kind: 'pending' };
  return { kind: 'settled', receipt, expense, ledger, author };
}

// Remembers the message a receipt's card was sent as, so the worker can edit it.
export function rememberReceiptCard(
  { db }: Pick<FetchDeps, 'db'>,
  receiptId: ReceiptId,
  card: { readonly chatId: number; readonly messageId: number },
): void {
  setReceiptCard(db, receiptId, card);
}
