import { listActiveCategories } from '../db/categories.js';
import {
  findExpenseById,
  findHistoryCategory,
  isSealed,
  type Expense,
  type ExpenseId,
} from '../db/expenses.js';
import { findLedgerForMember, type Ledger } from '../db/ledgers.js';
import { countReceiptItems, insertReceiptItems, listReceiptItems } from '../db/receiptItems.js';
import {
  fillReceiptCategory,
  fillReceiptDescription,
  findDueReceipt,
  findReceiptAuthor,
  findReceiptByExpense,
  findReceiptById,
  findReceiptExpenseState,
  markReceiptFetched,
  recordReceiptFailure,
  resetFailedReceipt,
  setReceiptCard,
  type Receipt,
  type ReceiptId,
} from '../db/receipts.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import { FALLBACK_PRESET } from '../domain/categoryPresets.js';
import type { FetchedItem, FetchedReceipt, ReceiptCountry } from '../domain/receipts/types.js';
import {
  foldedReceipt,
  isLocked,
  openExpense,
  plaintext,
  type KeyDeps,
  type Locked,
} from './ledgerKeys.js';
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
  let applied: boolean;
  try {
    applied = db.transaction(() => {
      if (!markReceiptFetched(db, receipt.id, fetched.sellerName)) return false;
      insertReceiptItems(db, receipt.id, fetched.items);
      enrichExpense(deps, receipt, fetched.sellerName);
      return true;
    })();
  } catch (error) {
    // The transaction rolled back and left the receipt `pending` and due: without a recorded
    // failure the next tick would fetch it again at once.
    deps.logger.warn(
      { receiptId: receipt.id, err: error instanceof Error ? error.name : typeof error },
      'fetched receipt failed to apply',
    );
    return failed(deps, receipt, 'error', input.now);
  }
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
  const expense = findPlaintextExpense(db, receipt.expenseId);
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
  const expense = receipt === undefined ? undefined : findPlaintextExpense(db, receipt.expenseId);
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

// Receipts exist only in plaintext ledgers: a sealed ledger takes none, and sealing one folds
// its receipts into the sealed rows (ADR-0020).
function findPlaintextExpense(db: FetchDeps['db'], id: ExpenseId): Expense | undefined {
  const stored = findExpenseById(db, id);
  return stored === undefined ? undefined : plaintext(stored);
}

// What a receipt expense's card shows about its receipt.
export interface ReceiptSummary {
  readonly state: Receipt['fetchState'];
  readonly sellerName: string | null;
  readonly itemCount: number;
}

export function receiptSummary(
  { db }: Pick<FetchDeps, 'db'>,
  expenseId: ExpenseId,
): ReceiptSummary | undefined {
  const receipt = findReceiptByExpense(db, expenseId);
  if (receipt === undefined) return undefined;
  return {
    state: receipt.fetchState,
    sellerName: receipt.sellerName,
    itemCount: receipt.fetchState === 'fetched' ? countReceiptItems(db, receipt.id) : 0,
  };
}

export type ReceiptItemsResult =
  | {
      readonly kind: 'items';
      readonly expense: Expense;
      readonly sellerName: string;
      readonly items: readonly FetchedItem[];
    }
  | { readonly kind: 'notFound' }
  // Only the expense's author sees its items.
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFetched' }
  | Locked;

// A sealed row's items come from the receipt folded into its payload (ADR-0020).
export function receiptItems(
  deps: Pick<FetchDeps, 'db'> & Pick<KeyDeps, 'keys'>,
  input: { readonly user: User; readonly expenseId: ExpenseId },
): ReceiptItemsResult {
  const { db } = deps;
  const stored = findExpenseById(db, input.expenseId);
  if (stored === undefined) return { kind: 'notFound' };
  if (stored.createdBy !== input.user.id) return { kind: 'forbidden' };
  const expense = openExpense(deps, stored);
  if (isLocked(expense)) return expense;
  if (isSealed(stored)) {
    const folded = foldedReceipt(deps, stored.id);
    if (folded === undefined) return { kind: 'notFound' };
    if (folded.sellerName === null) return { kind: 'notFetched' };
    return { kind: 'items', expense, sellerName: folded.sellerName, items: folded.items };
  }
  const receipt = findReceiptByExpense(db, expense.id);
  if (receipt === undefined) return { kind: 'notFound' };
  if (receipt.fetchState !== 'fetched' || receipt.sellerName === null) {
    return { kind: 'notFetched' };
  }
  return {
    kind: 'items',
    expense,
    sellerName: receipt.sellerName,
    items: listReceiptItems(db, receipt.id),
  };
}

export type RetryReceiptResult =
  | { readonly kind: 'retrying'; readonly expense: Expense; readonly ledger: Ledger }
  // Already pending or fetched: a double tap, or a stale card.
  | { readonly kind: 'notFailed' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' };

// [Повторить] on a failed receipt: back to `pending` with no attempts, due now. The caller kicks
// the worker.
export function retryReceipt(
  deps: Pick<FetchDeps, 'db' | 'logger'>,
  input: { readonly user: User; readonly expenseId: ExpenseId; readonly now: Date },
): RetryReceiptResult {
  const { db } = deps;
  const stored = findExpenseById(db, input.expenseId);
  // A sealed row's receipt was folded into it when its ledger was sealed: nothing to retry.
  if (stored === undefined || isSealed(stored)) return { kind: 'notFound' };
  const expense = plaintext(stored);
  if (expense.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, expense.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  const receipt = findReceiptByExpense(db, expense.id);
  if (receipt === undefined) return { kind: 'notFound' };
  if (!resetFailedReceipt(db, receipt.id, input.now)) return { kind: 'notFailed' };
  deps.logger.info({ receiptId: receipt.id, country: receipt.country }, 'receipt fetch retried');
  return { kind: 'retrying', expense, ledger };
}

// Remembers the message a receipt's card was sent as, so the worker can edit it.
export function rememberReceiptCard(
  { db }: Pick<FetchDeps, 'db'>,
  receiptId: ReceiptId,
  card: { readonly chatId: number; readonly messageId: number },
): void {
  setReceiptCard(db, receiptId, card);
}
