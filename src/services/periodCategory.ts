import { findCategory, type CategoryId } from '../db/categories.js';
import { listLedgerExpensesBetween, type ExpenseId } from '../db/expenses.js';
import { rateLookupBetween } from '../db/fxRates.js';
import { findLedgerForMember, listMemberNames, type Ledger, type LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { summarizeConverted, type CurrencySummary } from '../domain/aggregate.js';
import type { Money } from '../domain/money.js';
import type { Period } from '../domain/periods.js';
import { localDateOf, type LocalDate } from '../domain/time.js';
import { openExpenses, type KeyDeps, type Locked } from './ledgerKeys.js';
import type { PeriodSummary } from './periodSummary.js';
import { effectiveTimezone, type RecordDeps } from './recordExpense.js';

// The summary's drill-down (Plan 0037): a period's categories in the digest's order, and one
// category's expenses in that period, newest first, under the same totals the digest shows.

// A category of the picker; `id` null for the expenses without one.
export interface PeriodCategory {
  readonly id: CategoryId | null;
  readonly name: string | null;
}

// The picker's buttons: the first block's lines by amount, then the categories found only in the
// later (unconverted) blocks in order of appearance, the uncategorized line last. A category in
// several blocks is one button.
export function pickerCategories(summary: Pick<PeriodSummary, 'currencies'>): PeriodCategory[] {
  const seen = new Set<number>();
  const categories: PeriodCategory[] = [];
  let uncategorized = false;
  for (const block of summary.currencies) {
    for (const line of block.lines) {
      if (line.categoryId === null) {
        uncategorized = true;
        continue;
      }
      if (seen.has(line.categoryId)) continue;
      seen.add(line.categoryId);
      categories.push({ id: line.categoryId as CategoryId, name: line.name });
    }
  }
  return uncategorized ? [...categories, { id: null, name: null }] : categories;
}

export interface CategoryExpense {
  readonly id: ExpenseId;
  readonly occurredOn: LocalDate;
  // As recorded: never converted.
  readonly money: Money;
  readonly description: string;
  // A shared ledger's author: their member name, null when they have none. Absent in a personal
  // ledger.
  readonly author?: string | null;
}

export interface CategoryExpenses {
  readonly ledger: Ledger;
  readonly period: Period;
  readonly category: PeriodCategory;
  // The digest's blocks narrowed to this category: the ledger currency first, holding every
  // expense converted at its day's rate (ADR-0022), then each currency with no rate. Empty when
  // the category holds nothing in the period.
  readonly blocks: readonly CurrencySummary[];
  // The original totals of the foreign expenses converted into the first block.
  readonly convertedFrom: readonly Money[];
  // Newest first: by occurred_on, then occurred_at, then id.
  readonly expenses: readonly CategoryExpense[];
  // The category's 0-based place among the period's pickerCategories; undefined once nothing in
  // the period is in it.
  readonly pickerIndex: number | undefined;
}

type Deps = Pick<RecordDeps, 'db' | 'logger' | 'defaultTimezone'> & Pick<KeyDeps, 'keys'>;

// One category's expenses in a period of the ledger a summary screen was opened on, `null` for
// the uncategorized ones. Undefined once the user is no longer a member, for a period that starts
// after the ledger's today, or for a category the ledger doesn't have. A sealed ledger that is
// locked reads as `locked` (ADR-0020).
export function categoryExpenses(
  deps: Deps,
  input: {
    readonly user: User;
    readonly ledgerId: LedgerId;
    readonly period: Period;
    readonly categoryId: CategoryId | null;
    readonly now: Date;
  },
): CategoryExpenses | Locked | undefined {
  const { db } = deps;
  const ledger = findLedgerForMember(db, input.ledgerId, input.user.id);
  if (ledger === undefined) return undefined;
  const today = localDateOf(input.now, effectiveTimezone(deps, input.user, ledger));
  if (input.period.from > today) return undefined;
  const category =
    input.categoryId === null ? undefined : findCategory(db, ledger.id, input.categoryId);
  if (input.categoryId !== null && category === undefined) return undefined;

  const opened = openExpenses(
    deps,
    ledger.id,
    listLedgerExpensesBetween(db, {
      ledgerId: ledger.id,
      memberId: input.user.id,
      from: input.period.from,
      to: input.period.to,
    }),
  );
  if (opened.kind === 'locked') return opened;
  const inCategory = opened.expenses.filter(
    (expense) => (expense.category?.id ?? null) === input.categoryId,
  );
  const rateOf = rateLookupBetween(db, input.period.from, input.period.to);
  const blocksOf = (summary: ReturnType<typeof summarizeConverted>) =>
    summary.converted === undefined
      ? summary.unconverted
      : [summary.converted, ...summary.unconverted];
  const index = pickerCategories({
    currencies: blocksOf(summarizeConverted(opened.expenses, ledger.defaultCurrency, rateOf)),
  }).findIndex((c) => c.id === input.categoryId);
  // Each expense is converted before the sum, as in the digest, so these blocks equal its lines.
  const narrowed = summarizeConverted(inCategory, ledger.defaultCurrency, rateOf);
  const names = ledger.kind === 'shared' ? listMemberNames(db, ledger.id) : undefined;
  return {
    ledger,
    period: input.period,
    category: { id: input.categoryId, name: category?.name ?? null },
    blocks: blocksOf(narrowed),
    convertedFrom: narrowed.convertedFrom,
    // The rows come oldest first by the same three keys.
    expenses: inCategory.reverse().map((expense) => ({
      id: expense.id,
      occurredOn: expense.occurredOn,
      money: { amountMinor: expense.amountMinor, currency: expense.currency },
      description: expense.description,
      ...(names === undefined ? {} : { author: names.get(expense.createdBy) ?? null }),
    })),
    pickerIndex: index === -1 ? undefined : index,
  };
}
