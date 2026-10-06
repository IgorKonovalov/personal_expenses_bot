import { createHash } from 'node:crypto';
import { TZDate } from '@date-fns/tz';
import { listActiveCategories } from '../db/categories.js';
import type { ExpenseId } from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { descriptionKey, suggestCategory } from '../domain/categories.js';
import type { Money } from '../domain/money.js';
import { RAIFFEISEN_RS } from '../domain/statements/raiffeisenRs.js';
import type { StatementPeriod, StatementPurchase } from '../domain/statements/types.js';
import { cancelFlow, pendingStatementFlow, startStatementFlow } from './flowSessions.js';
import type { KeyDeps } from './ledgerKeys.js';
import { historyCategory, storeExpense, type RecordDeps } from './recordExpense.js';

// Bank statement import (Plan 0027): a parsed statement's card purchases are previewed and held
// in a flow session, and a tap records them as ordinary expenses in their original currency.

// Statement dates are local dates in Serbia; each row is stamped at noon there, so a ledger in
// another timezone still dates it the same day.
const STATEMENT_TIMEZONE = 'Europe/Belgrade';
const STAMP_HOUR = 12;

type ImportDeps = RecordDeps & Partial<Pick<KeyDeps, 'keys'>>;

export interface StatementPreview {
  readonly kind: 'preview';
  readonly ledger: Ledger;
  readonly period: StatementPeriod | undefined;
  readonly purchases: readonly StatementPurchase[];
  // The purchases [Записать все] records.
  readonly fresh: readonly StatementPurchase[];
}

// Holds the statement's purchases for the active ledger and describes the preview.
export function previewStatement(
  deps: ImportDeps,
  input: {
    readonly user: User;
    readonly period: StatementPeriod | undefined;
    readonly purchases: readonly StatementPurchase[];
    readonly now: Date;
  },
): StatementPreview {
  const { db, logger } = deps;
  const { user, period, purchases } = input;
  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  startStatementFlow(deps, user, { ledgerId: ledger.id, period, purchases }, input.now);
  logger.info(
    { userId: user.id, ledgerId: ledger.id, purchases: purchases.length },
    'statement previewed',
  );
  return { kind: 'preview', ledger, period, purchases, fresh: purchases };
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
  | { readonly kind: 'expired' };

// Records the pending statement's purchases into the ledger it was previewed for, all in one
// transaction that also clears the flow, so a second tap finds nothing pending. Each row's
// source key fingerprints the row and the ledger (ADR-0032), so a row stored before records
// nothing.
export function recordStatement(
  deps: ImportDeps,
  input: { readonly user: User; readonly now: Date },
): RecordStatementResult {
  const { db, logger } = deps;
  const { user, now } = input;
  const flow = pendingStatementFlow(deps, user, now);
  if (flow === undefined) return { kind: 'expired' };
  const ledger = findLedgerForMember(db, flow.ledgerId, user.id);
  if (ledger === undefined) return { kind: 'expired' };

  const recorded = db.transaction(() => {
    const categories = listActiveCategories(db, ledger.id);
    const created: StatementPurchase[] = [];
    for (const purchase of flow.purchases) {
      const key = descriptionKey(purchase.merchant);
      const category = suggestCategory({
        description: purchase.merchant,
        categories,
        historyCategoryId: historyCategory(deps, ledger.id, key),
      });
      const stored = storeExpense(deps, {
        id: deps.newId() as ExpenseId,
        ledgerId: ledger.id,
        createdBy: user.id,
        amountMinor: purchase.amountMinor,
        currency: purchase.currency,
        description: purchase.merchant,
        occurredAt: stampOf(purchase),
        occurredOn: purchase.date,
        sourceKey: statementSourceKey(purchase, ledger.id),
        createdAt: now,
        category: { id: category.id, name: category.name },
        descriptionKey: key,
      });
      if (stored.kind === 'stored' && stored.created) created.push(purchase);
    }
    cancelFlow(deps, user);
    return created;
  })();

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

function stampOf(purchase: StatementPurchase): Date {
  const [year = 0, month = 1, day = 1] = purchase.date.split('-').map(Number);
  return new Date(new TZDate(year, month - 1, day, STAMP_HOUR, 0, 0, STATEMENT_TIMEZONE).getTime());
}
