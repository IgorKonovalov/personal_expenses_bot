import { createHash } from 'node:crypto';
import { TZDate } from '@date-fns/tz';
import { listActiveCategories } from '../db/categories.js';
import { findTakenSourceKeys, listLedgerExpensesBetween, type ExpenseId } from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import type { Money } from '../domain/money.js';
import { matchRows } from '../domain/statements/match.js';
import { RAIFFEISEN_RS } from '../domain/statements/raiffeisenRs.js';
import type { StatementPeriod, StatementPurchase } from '../domain/statements/types.js';
import type { LocalDate } from '../domain/time.js';
import { cancelFlow, pendingStatementFlow, startStatementFlow } from './flowSessions.js';
import {
  isLocked,
  isSealedLedger,
  ledgerIsLocked,
  LOCKED,
  openExpenses,
  type KeyDeps,
  type Locked,
} from './ledgerKeys.js';
import { historyCategory, storeExpense, type RecordDeps } from './recordExpense.js';

// Bank statement import (Plan 0027): a parsed statement's card purchases are previewed and held
// in a flow session, and a tap records them as ordinary expenses in their original currency.

// Statement dates are local dates in Serbia; each row is stamped at noon there, so a ledger in
// another timezone still dates it the same day.
const STATEMENT_TIMEZONE = 'Europe/Belgrade';
const STAMP_HOUR = 12;

// The caps that bound an import's memory (ADR-0033): the file, refused before download; its
// pages, refused before any is read; and its card purchases.
export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const MAX_STATEMENT_PAGES = 30;
export const MAX_STATEMENT_PURCHASES = 1000;

type ImportDeps = RecordDeps & Pick<KeyDeps, 'keys'>;

export interface StatementPreview {
  readonly kind: 'preview';
  readonly ledger: Ledger;
  readonly period: StatementPeriod | undefined;
  readonly purchases: readonly StatementPurchase[];
  // The purchases [Записать все] records.
  readonly fresh: readonly StatementPurchase[];
  // Rows a live expense already covers (ADR-0032): [Записать и уже записанные] adds them.
  readonly matched: readonly StatementPurchase[];
  // Rows whose source key is already stored: an earlier import recorded them.
  readonly imported: readonly StatementPurchase[];
}

// Where each row of a statement stands against a ledger.
type RowState = 'fresh' | 'matched' | 'imported';

// A row whose source key is stored was imported before, and its own expense is no candidate for
// another row. The rest are matched against the ledger's other live expenses within a day of
// the statement's dates (ADR-0032). Matching reads amounts, so a sealed ledger's rows are opened,
// and while it is locked nothing can be classified.
function classify(
  deps: ImportDeps,
  user: User,
  ledgerId: LedgerId,
  purchases: readonly StatementPurchase[],
): RowState[] | Locked {
  const { db } = deps;
  const keys = purchases.map((purchase) => statementSourceKey(purchase, ledgerId));
  const taken = findTakenSourceKeys(db, keys);
  const own = new Set(keys);
  const dates = purchases.map((purchase) => purchase.date).sort();
  const [first] = dates;
  const last = dates.at(-1);
  if (first === undefined || last === undefined) {
    return ledgerIsLocked(deps, ledgerId) ? LOCKED : [];
  }
  const opened = openExpenses(
    deps,
    ledgerId,
    listLedgerExpensesBetween(db, {
      ledgerId,
      memberId: user.id,
      from: shiftDays(first, -1),
      to: shiftDays(last, 1),
    }),
  );
  if (isLocked(opened)) return opened;
  const candidates = opened.expenses.filter((expense) => !own.has(expense.sourceKey));

  const open = purchases.flatMap((purchase, index) =>
    taken.has(keys[index] ?? '') ? [] : [purchase],
  );
  const matches = matchRows(open, candidates);
  let next = 0;
  return purchases.map((_, index) => {
    if (taken.has(keys[index] ?? '')) return 'imported';
    return matches[next++] === undefined ? 'fresh' : 'matched';
  });
}

function pick(
  purchases: readonly StatementPurchase[],
  states: readonly RowState[],
  wanted: RowState,
): StatementPurchase[] {
  return purchases.filter((_, index) => states[index] === wanted);
}

function describePreview(
  deps: ImportDeps,
  user: User,
  ledger: Ledger,
  statement: {
    readonly period: StatementPeriod | undefined;
    readonly purchases: readonly StatementPurchase[];
  },
): StatementPreview | Locked {
  const { period, purchases } = statement;
  const states = classify(deps, user, ledger.id, purchases);
  if (isLocked(states)) return states;
  return {
    kind: 'preview',
    ledger,
    period,
    purchases,
    fresh: pick(purchases, states, 'fresh'),
    matched: pick(purchases, states, 'matched'),
    imported: pick(purchases, states, 'imported'),
  };
}

// Holds the statement's purchases for the active ledger and describes the preview. A statement
// over the purchase cap, or one for a sealed ledger that is locked (Plan 0019), is refused and
// nothing is held.
export function previewStatement(
  deps: ImportDeps,
  input: {
    readonly user: User;
    readonly period: StatementPeriod | undefined;
    readonly purchases: readonly StatementPurchase[];
    readonly now: Date;
  },
): StatementPreview | Locked | { readonly kind: 'tooLong' } {
  const { db, logger } = deps;
  const { user, period, purchases } = input;
  if (purchases.length > MAX_STATEMENT_PURCHASES) return { kind: 'tooLong' };
  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  const preview = describePreview(deps, user, ledger, { period, purchases });
  if (isLocked(preview)) {
    logger.info({ userId: user.id, ledgerId: ledger.id }, 'statement refused: ledger locked');
    return preview;
  }
  startStatementFlow(deps, user, { ledgerId: ledger.id, period, purchases }, input.now);
  logger.info(
    {
      userId: user.id,
      ledgerId: ledger.id,
      purchases: purchases.length,
      fresh: preview.fresh.length,
      matched: preview.matched.length,
      imported: preview.imported.length,
    },
    'statement previewed',
  );
  return preview;
}

// The pending statement's preview again, for a page tap: classified against the ledger as it is
// now, the flow left as it is.
export function pendingStatementPreview(
  deps: ImportDeps,
  input: { readonly user: User; readonly now: Date },
): StatementPreview | Locked | { readonly kind: 'expired' } {
  const { user, now } = input;
  const flow = pendingStatementFlow(deps, user, now);
  if (flow === undefined) return { kind: 'expired' };
  const ledger = findLedgerForMember(deps.db, flow.ledgerId, user.id);
  if (ledger === undefined) return { kind: 'expired' };
  return describePreview(deps, user, ledger, flow);
}

export type RecordStatementResult =
  | {
      readonly kind: 'recorded';
      readonly ledger: Ledger;
      // The expenses this tap created.
      readonly count: number;
      // Their totals per currency, in order of first appearance; never converted.
      readonly totals: readonly Money[];
    }
  // No statement is pending: it expired, was recorded or cancelled, or another flow replaced it.
  | { readonly kind: 'expired' }
  // The sealed ledger was locked after the preview: nothing is recorded, the statement stays held.
  | Locked;

// Records the pending statement's new rows, and with `withMatched` the rows a live expense
// already covers, into the ledger it was previewed for. The rows are classified again inside
// one transaction that also clears the flow, so a second tap finds nothing pending. Each row's
// source key fingerprints the row and the ledger (ADR-0032), so a row stored before records
// nothing.
export function recordStatement(
  deps: ImportDeps,
  input: { readonly user: User; readonly now: Date; readonly withMatched?: boolean },
): RecordStatementResult {
  const { db, logger } = deps;
  const { user, now } = input;
  const flow = pendingStatementFlow(deps, user, now);
  if (flow === undefined) return { kind: 'expired' };
  const ledger = findLedgerForMember(db, flow.ledgerId, user.id);
  if (ledger === undefined) return { kind: 'expired' };

  const recorded = db.transaction((): StatementPurchase[] | Locked => {
    const states = classify(deps, user, ledger.id, flow.purchases);
    if (isLocked(states)) return states;
    const sealed = isSealedLedger(deps, ledger.id);
    const chosen = flow.purchases.filter(
      (_, index) =>
        states[index] === 'fresh' || (input.withMatched === true && states[index] === 'matched'),
    );
    const categories = listActiveCategories(db, ledger.id);
    const created: StatementPurchase[] = [];
    for (const purchase of chosen) {
      const key = descriptionKey(purchase.merchant);
      const category = suggestCategory({
        description: purchase.merchant,
        categories,
        historyCategoryId: historyCategory(deps, ledger.id, key),
      });
      const id = deps.newId() as ExpenseId;
      // A sealed row's key carries no content (ADR-0020): a fingerprint would let a file holder
      // confirm a guessed purchase. There the match on the opened amounts is what keeps a
      // re-sent statement from recording twice.
      const stored = storeExpense(deps, {
        id,
        ledgerId: ledger.id,
        createdBy: user.id,
        amountMinor: purchase.amountMinor,
        currency: purchase.currency,
        description: purchase.merchant,
        occurredAt: stampOf(purchase),
        occurredOn: purchase.date,
        sourceKey: sealed ? `sealed:${id}` : statementSourceKey(purchase, ledger.id),
        createdAt: now,
        category: { id: category.id, name: category.name },
        descriptionKey: key,
      });
      if (stored.kind === 'stored' && stored.created) created.push(purchase);
    }
    cancelFlow(deps, user);
    return created;
  })();
  if (isLocked(recorded)) return recorded;

  logger.info(
    { userId: user.id, ledgerId: ledger.id, recorded: recorded.length },
    'statement recorded',
  );
  return { kind: 'recorded', ledger, count: recorded.length, totals: totalsOf(recorded) };
}

// [Отмена]: drops the pending statement. Returns false when none was pending.
export function cancelStatement(
  deps: ImportDeps,
  input: { readonly user: User; readonly now: Date },
) {
  if (pendingStatementFlow(deps, input.user, input.now) === undefined) return false;
  return cancelFlow(deps, input.user);
}

// `stmt:raiffeisen-rs:<sha256 of date|amount|currency|merchant|ordinal>:<ledgerId>`.
export function statementSourceKey(purchase: StatementPurchase, ledgerId: LedgerId): string {
  const fingerprint = createHash('sha256')
    .update(
      [
        purchase.date,
        purchase.amountMinor,
        purchase.currency,
        purchase.merchant,
        purchase.ordinal,
      ].join('|'),
    )
    .digest('hex');
  return `stmt:${RAIFFEISEN_RS}:${fingerprint}:${ledgerId}`;
}

// Totals per currency, in order of first appearance.
export function totalsOf(purchases: readonly StatementPurchase[]): Money[] {
  const totals = new Map<Money['currency'], number>();
  for (const { currency, amountMinor } of purchases) {
    totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
  }
  return [...totals].map(([currency, amountMinor]) => ({ amountMinor, currency }));
}

// A local date moved by whole days, on the calendar alone.
function shiftDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10) as LocalDate;
}

function stampOf(purchase: StatementPurchase): Date {
  const [year = 0, month = 1, day = 1] = purchase.date.split('-').map(Number);
  return new Date(new TZDate(year, month - 1, day, STAMP_HOUR, 0, 0, STATEMENT_TIMEZONE).getTime());
}
