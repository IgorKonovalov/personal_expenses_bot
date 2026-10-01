import {
  clearCategoryCap,
  deleteLedgerCaps,
  ensureLedgerBudget,
  findLedgerBudget,
  listLedgerCaps,
  setBudgetLimit,
  setBudgetScope,
  setBudgetStartDay,
  setCategoryCap,
  type BudgetScope,
  type LedgerBudget,
} from '../db/budgets.js';
import {
  findCategory,
  listActiveCategories,
  listEssentialCategoryIds,
  type CategoryId,
} from '../db/categories.js';
import { listLedgerExpensesBetween } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import {
  findActiveLedger,
  findLedgerForMember,
  findMemberRole,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import type { User, UserId } from '../db/users.js';
import { countInto, dayOfPeriod, isSafeLimit, remainders } from '../domain/budget.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { parseAmount, type AmountReading } from '../domain/money.js';
import { budgetPeriodOf } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import {
  cancelFlow,
  cancelFlowIf,
  completeFlow,
  startFlow,
  type BudgetFlow,
} from './flowSessions.js';
import { boundGroupLedger } from './periodSummary.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// Budgets (ADR-0017): computed at read time from `expenses`, in the ledger's effective timezone
// (ADR-0015), over every expense converted into the budget's currency at its day's NBS rate
// (ADR-0023). Nothing is materialised.

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
  readonly scope: BudgetScope;
  readonly limit?: BudgetLimitStatus;
  // Each active capped category's spend in the period, in the budget's currency, whatever the
  // scope. Empty when no category has a cap.
  readonly caps: readonly CapStatus[];
  // True when any foreign expense in the period was converted into the figures.
  readonly converted: boolean;
  // Spend in the period with no rate, per currency: listed, never counted (ADR-0023).
  readonly notCounted: ReadonlyMap<CurrencyCode, number>;
}

export interface CapStatus {
  readonly categoryId: CategoryId;
  readonly name: string;
  readonly spentMinor: number;
  readonly capMinor: number;
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
  const { from, to } = budgetPeriodOf(today, budget.periodStartDay);
  const period: BudgetPeriod = {
    from,
    to,
    day: dayOfPeriod(from, today),
    days: dayOfPeriod(from, to),
  };
  const all = listLedgerExpensesBetween(db, {
    ledgerId: ledger.id,
    memberId: input.readerId,
    from,
    to,
  });
  // Scope `optional` leaves out essential categories; an uncategorised expense is optional.
  const essential =
    budget.scope === 'optional' ? listEssentialCategoryIds(db, ledger.id) : new Set<CategoryId>();
  const expenses = all.filter((e) => e.category === null || !essential.has(e.category.id));
  const rateOf = rateLookupBetween(db, from, to);
  const inPeriod = countInto(expenses, budget.currency, rateOf);
  const throughToday = countInto(
    expenses.filter((e) => e.occurredOn <= today),
    budget.currency,
    rateOf,
  );
  const caps = listLedgerCaps(db, ledger.id).map(({ categoryId, name, capMinor }) => ({
    categoryId,
    name,
    capMinor,
    spentMinor: countInto(
      all.filter((e) => e.category?.id === categoryId),
      budget.currency,
      rateOf,
    ).countedMinor,
  }));
  const base = {
    ledger,
    budget,
    period,
    currency: budget.currency,
    scope: budget.scope,
    caps,
    // Caps count every category whatever the scope, so the whole period is asked.
    converted: countInto(all, budget.currency, rateOf).converted,
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

// A bound group's budget, read through its binding (ADR-0014) and dated in the ledger's own
// timezone (ADR-0015), for the read-only group /budget. Undefined for an unbound chat.
export function groupBudgetStatus(
  deps: Deps,
  input: { readonly chatId: number; readonly now: Date },
): { readonly ledger: Ledger; readonly status?: BudgetStatus } | undefined {
  const bound = boundGroupLedger(deps, input.chatId);
  if (bound === undefined) return undefined;
  const { ledger, readerId } = bound;
  const status = budgetStatus(deps, { ledger, readerId, today: bound.today(input.now) });
  return status === undefined ? { ledger } : { ledger, status };
}

export interface BudgetScreenView {
  readonly ledger: Ledger;
  readonly status?: BudgetStatus;
  // The ledger's active categories with their caps (null: none), for the cap list.
  readonly categories: readonly {
    readonly id: CategoryId;
    readonly name: string;
    readonly capMinor: number | null;
  }[];
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
  const capOf = new Map(listLedgerCaps(deps.db, ledger.id).map((c) => [c.categoryId, c.capMinor]));
  const categories = listActiveCategories(deps.db, ledger.id).map((c) => ({
    id: c.id,
    name: c.name,
    capMinor: capOf.get(c.id) ?? null,
  }));
  return status === undefined ? { ledger, categories } : { ledger, status, categories };
}

export type ClearCapResult = { readonly kind: 'cleared' | 'unchanged' | 'forbidden' };

// Removes a category's cap. Clears a pending cap flow for the same category, so its prompt's
// answer can't put the cap back.
export function clearCap(
  deps: Deps,
  input: { readonly user: User; readonly ledgerId: LedgerId; readonly categoryId: CategoryId },
): ClearCapResult {
  const { db, logger } = deps;
  const { user, ledgerId, categoryId } = input;
  return db.transaction((): ClearCapResult => {
    if (ownedLedger(deps, user, ledgerId) === undefined) return { kind: 'forbidden' };
    if (findCategory(db, ledgerId, categoryId) === undefined) return { kind: 'forbidden' };
    cancelFlowIf(deps, user, (flow) => flow.kind === 'budgetCap' && flow.categoryId === categoryId);
    if (!clearCategoryCap(db, categoryId)) return { kind: 'unchanged' };
    logger.info({ ledgerId, categoryId, userId: user.id }, 'category cap cleared');
    return { kind: 'cleared' };
  })();
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
  const { flow } = input;
  if (ownedLedger(deps, input.user, flow.ledgerId) === undefined) return false;
  if (flow.kind === 'budgetCap') {
    const category = findCategory(deps.db, flow.ledgerId, flow.categoryId);
    if (category === undefined || category.archivedAt !== null) return false;
  }
  startFlow(deps, input.user, flow, input.now);
  return true;
}

export type ScopeResult = { readonly kind: 'set' | 'unchanged' | 'forbidden' };

// Sets what the limit counts: every expense, or only those outside essential categories.
// Absolute, so a double tap converges.
export function setScope(
  deps: Deps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly scope: BudgetScope;
    readonly now: Date;
  },
): ScopeResult {
  const { db, logger } = deps;
  return db.transaction((): ScopeResult => {
    const ledger = ownedLedger(deps, input.user, input.ledgerId);
    if (ledger === undefined) return { kind: 'forbidden' };
    const currency = findLedgerBudget(db, ledger.id)?.currency ?? ledger.defaultCurrency;
    if (!setBudgetScope(db, ledger.id, { scope: input.scope, currency }, input.now)) {
      return { kind: 'unchanged' };
    }
    logger.info({ ledgerId: ledger.id, userId: input.user.id, field: 'scope' }, 'budget changed');
    return { kind: 'set' };
  })();
}

export type BudgetRefusal =
  | { readonly reason: 'invalidAmount' | 'tooLarge' | 'expenseShaped' | 'invalidDay' }
  | {
      readonly reason: 'ambiguousAmount';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
    };

export type BudgetAnswerResult =
  | {
      readonly kind: 'set';
      readonly ledger: Ledger;
      // Present when a limit in a new currency deleted the ledger's category caps: theirs.
      readonly droppedCapsCurrency?: CurrencyCode;
    }
  // The flow stays pending and the prompt is asked again.
  | ({
      readonly kind: 'invalid';
      readonly ledger: Ledger;
      readonly current?: LedgerBudget;
    } & BudgetRefusal)
  // The user no longer owns the ledger: the flow is cleared, nothing written.
  | { readonly kind: 'gone' };

type LimitAnswer =
  | { readonly kind: 'ok'; readonly amountMinor: number }
  | { readonly kind: 'refused'; readonly refusal: BudgetRefusal };

// An amount in the ledger's default currency, small enough for exact allowance arithmetic.
function parseLimit(text: string, currency: CurrencyCode): LimitAnswer {
  const parsed = parseAmount(text, currency);
  switch (parsed.kind) {
    case 'ambiguous':
      return {
        kind: 'refused',
        refusal: { reason: 'ambiguousAmount', readings: parsed.readings, currency },
      };
    case 'invalid':
      return { kind: 'refused', refusal: { reason: 'invalidAmount' } };
    case 'ok':
      return isSafeLimit(parsed.amountMinor)
        ? { kind: 'ok', amountMinor: parsed.amountMinor }
        : { kind: 'refused', refusal: { reason: 'tooLarge' } };
  }
}

// A day of the month, 1 to 31, as plain digits.
function parseStartDay(text: string): number | undefined {
  if (!/^\d{1,2}$/.test(text)) return undefined;
  const day = Number(text);
  return day >= 1 && day <= 31 ? day : undefined;
}

// A typed budget setting. A limit is read in the ledger's default currency, which the budget
// adopts. The write and the flow's completion commit together, keyed by `inputKey`, so a
// redelivered answer finds the flow already answered.
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
    const refuse = (refusal: BudgetRefusal): BudgetAnswerResult =>
      current === undefined
        ? { kind: 'invalid', ledger, ...refusal }
        : { kind: 'invalid', ledger, current, ...refusal };
    const text = input.text.trim();
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    const asExpense = parseExpenseText(text, ledger.defaultCurrency).kind;
    if (asExpense === 'expense' || asExpense === 'ambiguous') {
      return refuse({ reason: 'expenseShaped' });
    }
    let changed: boolean;
    let droppedCapsCurrency: CurrencyCode | undefined;
    switch (flow.kind) {
      case 'budgetLimit': {
        const limit = parseLimit(text, ledger.defaultCurrency);
        if (limit.kind === 'refused') return refuse(limit.refusal);
        // A budget's amounts share one currency (ADR-0017): caps in the old one are deleted.
        if (
          current !== undefined &&
          current.currency !== ledger.defaultCurrency &&
          deleteLedgerCaps(db, ledger.id) > 0
        ) {
          droppedCapsCurrency = current.currency;
        }
        changed = setBudgetLimit(
          db,
          ledger.id,
          { limitMinor: limit.amountMinor, currency: ledger.defaultCurrency },
          input.now,
        );
        break;
      }
      case 'budgetStartDay': {
        const startDay = parseStartDay(text);
        if (startDay === undefined) return refuse({ reason: 'invalidDay' });
        changed = setBudgetStartDay(
          db,
          ledger.id,
          { startDay, currency: current?.currency ?? ledger.defaultCurrency },
          input.now,
        );
        break;
      }
      case 'budgetCap': {
        // A cap is in the budget's currency; a ledger without a budget gets one in its default.
        const category = findCategory(db, ledger.id, flow.categoryId);
        if (category === undefined || category.archivedAt !== null) {
          cancelFlow(deps, user);
          return { kind: 'gone' };
        }
        const currency = current?.currency ?? ledger.defaultCurrency;
        const cap = parseLimit(text, currency);
        if (cap.kind === 'refused') return refuse(cap.refusal);
        ensureLedgerBudget(db, ledger.id, currency, input.now);
        changed = setCategoryCap(db, category.id, cap.amountMinor, input.now);
        break;
      }
    }
    completeFlow(deps, user, input.inputKey);
    if (changed) {
      logger.info({ ledgerId: ledger.id, userId: user.id, field: flow.kind }, 'budget changed');
    }
    return droppedCapsCurrency === undefined
      ? { kind: 'set', ledger }
      : { kind: 'set', ledger, droppedCapsCurrency };
  })();
}
