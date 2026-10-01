import { findLedgerBudget, setBudgetLimit, type LedgerBudget } from '../db/budgets.js';
import { listLedgerExpensesBetween } from '../db/expenses.js';
import {
  findActiveLedger,
  findLedgerForMember,
  findMemberRole,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import { dayOfPeriod, isSafeLimit, remainders, splitByCurrency } from '../domain/budget.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { parseAmount, type AmountReading } from '../domain/money.js';
import { monthOf } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { cancelFlow, completeFlow, startFlow, type BudgetFlow } from './flowSessions.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// Budgets (ADR-0017): computed at read time from `expenses`, in the ledger's effective timezone
// (ADR-0015), over expenses in the budget's currency. Nothing is materialised.

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'>;

export interface BudgetPeriod {
  readonly from: LocalDate;
  readonly to: LocalDate;
  // 1-based: today's position in the period, and the period's length.
  readonly day: number;
  readonly days: number;
}

export interface BudgetLimitStatus {
  readonly limitMinor: number;
  readonly spentMinor: number;
  readonly todayLeftMinor: number;
  readonly periodLeftMinor: number;
}

export interface BudgetStatus {
  readonly ledger: Ledger;
  readonly budget: LedgerBudget;
  readonly period: BudgetPeriod;
  readonly currency: CurrencyCode;
  readonly limit?: BudgetLimitStatus;
  // Spend in the period in other currencies: listed, never converted (ADR-0003).
  readonly notCounted: ReadonlyMap<CurrencyCode, number>;
}

// The ledger's budget as of the local date `today`, reading expenses through `readerId`'s
// membership. Undefined when the ledger has no budget.
export function budgetStatus(
  { db }: Deps,
  input: { readonly ledger: Ledger; readonly readerId: UserId; readonly today: LocalDate },
): BudgetStatus | undefined {
  const { ledger, today } = input;
  const budget = findLedgerBudget(db, ledger.id);
  if (budget === undefined) return undefined;
  const { from, to } = monthOf(today);
  const period: BudgetPeriod = {
    from,
    to,
    day: dayOfPeriod(from, today),
    days: dayOfPeriod(from, to),
  };
  const expenses = listLedgerExpensesBetween(db, {
    ledgerId: ledger.id,
    memberId: input.readerId,
    from,
    to,
  });
  const inPeriod = splitByCurrency(expenses, budget.currency);
  const throughToday = splitByCurrency(
    expenses.filter((e) => e.occurredOn <= today),
    budget.currency,
  );
  const base = {
    ledger,
    budget,
    period,
    currency: budget.currency,
    notCounted: inPeriod.notCounted,
  };
  if (budget.limitMinor === null) return base;
  return {
    ...base,
    limit: {
      limitMinor: budget.limitMinor,
      spentMinor: inPeriod.countedMinor,
      ...remainders({
        limitMinor: budget.limitMinor,
        days: period.days,
        day: period.day,
        spentThroughTodayMinor: throughToday.countedMinor,
        spentInPeriodMinor: inPeriod.countedMinor,
      }),
    },
  };
}

// The budget of a ledger the user is a member of, as of their `now` in the ledger's effective
// timezone. Undefined for a non-member or a ledger without a budget.
export function memberBudgetStatus(
  deps: Deps,
  input: { readonly user: User; readonly ledger: Ledger; readonly now: Date },
): BudgetStatus | undefined {
  const { user, ledger } = input;
  if (findLedgerForMember(deps.db, ledger.id, user.id) === undefined) return undefined;
  const today = localDateOf(input.now, effectiveTimezone(deps, user, ledger));
  return budgetStatus(deps, { ledger, readerId: user.id, today });
}

export interface BudgetScreenView {
  readonly ledger: Ledger;
  readonly status?: BudgetStatus;
}

// What the /budget screen shows for a ledger the user may set the budget of: its owner.
// Undefined for anyone else, or once the user is no longer a member.
export function budgetScreen(
  deps: Deps,
  input: { readonly user: User; readonly ledgerId: LedgerId; readonly now: Date },
): BudgetScreenView | undefined {
  const ledger = ownedLedger(deps, input.user, input.ledgerId);
  if (ledger === undefined) return undefined;
  const status = memberBudgetStatus(deps, { user: input.user, ledger, now: input.now });
  return status === undefined ? { ledger } : { ledger, status };
}

// The ledger /budget opens on: the user's active one.
export function activeLedgerId({ db }: Deps, user: User): LedgerId {
  const ledger = findActiveLedger(db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  return ledger.id;
}

function ownedLedger({ db }: Deps, user: User, ledgerId: LedgerId): Ledger | undefined {
  const ledger = findLedgerForMember(db, ledgerId, user.id);
  if (ledger === undefined) return undefined;
  return findMemberRole(db, ledgerId, user.id) === 'owner' ? ledger : undefined;
}

// Starts a budget text flow on a ledger the user owns. False when they don't own it.
export function startBudgetFlow(
  deps: Deps,
  input: { readonly user: User; readonly flow: BudgetFlow; readonly now: Date },
): boolean {
  if (ownedLedger(deps, input.user, input.flow.ledgerId) === undefined) return false;
  startFlow(deps, input.user, input.flow, input.now);
  return true;
}

export type LimitRefusal =
  | { readonly reason: 'invalidAmount' | 'tooLarge' | 'expenseShaped' }
  | { readonly reason: 'ambiguousAmount'; readonly readings: readonly AmountReading[] };

export type BudgetAnswerResult =
  | { readonly kind: 'set'; readonly ledger: Ledger }
  // The flow stays pending and the prompt is asked again.
  | ({
      readonly kind: 'invalid';
      readonly ledger: Ledger;
      readonly current?: LedgerBudget;
    } & LimitRefusal)
  // The user no longer owns the ledger: the flow is cleared, nothing written.
  | { readonly kind: 'gone' };

// A typed limit, in the ledger's default currency, which the budget adopts. The write and the
// flow's completion commit together, keyed by `inputKey`, so a redelivered answer finds the flow
// already answered.
export function answerBudgetFlow(
  deps: Deps,
  input: {
    readonly user: User;
    readonly flow: BudgetFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): BudgetAnswerResult {
  const { db, logger } = deps;
  const { user, flow } = input;
  return db.transaction((): BudgetAnswerResult => {
    const ledger = ownedLedger(deps, user, flow.ledgerId);
    if (ledger === undefined) {
      cancelFlow(deps, user);
      return { kind: 'gone' };
    }
    const current = findLedgerBudget(db, ledger.id);
    const refuse = (refusal: LimitRefusal): BudgetAnswerResult =>
      current === undefined
        ? { kind: 'invalid', ledger, ...refusal }
        : { kind: 'invalid', ledger, current, ...refusal };
    const text = input.text.trim();
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    const asExpense = parseExpenseText(text, ledger.defaultCurrency).kind;
    if (asExpense === 'expense' || asExpense === 'ambiguous') {
      return refuse({ reason: 'expenseShaped' });
    }
    const parsed = parseAmount(text, ledger.defaultCurrency);
    if (parsed.kind === 'ambiguous') {
      return refuse({ reason: 'ambiguousAmount', readings: parsed.readings });
    }
    if (parsed.kind === 'invalid') return refuse({ reason: 'invalidAmount' });
    if (!isSafeLimit(parsed.amountMinor)) return refuse({ reason: 'tooLarge' });
    const changed = setBudgetLimit(
      db,
      ledger.id,
      { limitMinor: parsed.amountMinor, currency: ledger.defaultCurrency },
      input.now,
    );
    completeFlow(deps, user, input.inputKey);
    if (changed) logger.info({ ledgerId: ledger.id, userId: user.id }, 'budget limit set');
    return { kind: 'set', ledger };
  })();
}
