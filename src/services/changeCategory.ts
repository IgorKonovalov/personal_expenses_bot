import { listActiveCategories, type Category, type CategoryId } from '../db/categories.js';
import {
  findExpenseById,
  isSealed,
  resealExpense,
  setExpenseCategory,
  type Expense,
  type ExpenseId,
  type StoredExpense,
} from '../db/expenses.js';
import { findLedgerForMember, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import { isLocked, openExpense, resealed, type KeyDeps, type Locked } from './ledgerKeys.js';
import type { RecordDeps } from './recordExpense.js';

// Changing an expense's category from its card (ADR-0011). The expense's stored state is the
// guard: only its creator may change it, and only while it isn't deleted. The change is also
// the learning signal of ADR-0008: the corrected expense is what the history step matches.
// An expense of a sealed ledger (ADR-0020) is shown only while unlocked, and a change seals its
// whole payload again.

type Deps = Pick<RecordDeps, 'db'> & Pick<KeyDeps, 'keys'>;

interface ExpenseInput {
  readonly user: User;
  readonly expenseId: ExpenseId;
}

type Refusal =
  | { readonly kind: 'notFound' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'deleted' }
  | Locked;

export type ShowExpenseResult =
  | { readonly kind: 'card'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'notFound' }
  | Locked;

// The expense for its card, to any member of its ledger. Read-only.
export function showExpense(deps: Deps, input: ExpenseInput): ShowExpenseResult {
  const stored = findExpenseById(deps.db, input.expenseId);
  const ledger =
    stored === undefined ? undefined : findLedgerForMember(deps.db, stored.ledgerId, input.user.id);
  if (stored === undefined || ledger === undefined) return { kind: 'notFound' };
  const expense = openExpense(deps, stored);
  return isLocked(expense) ? expense : { kind: 'card', expense, ledger };
}

export type CategoryPickerResult =
  | {
      readonly kind: 'picker';
      readonly expense: Expense;
      readonly ledger: Ledger;
      readonly categories: readonly Category[];
    }
  | Refusal;

// The ledger's active categories to pick from, for the expense's creator.
export function openCategoryPicker(deps: Deps, input: ExpenseInput): CategoryPickerResult {
  const found = editableExpense(deps, input);
  if (found.kind !== 'editable') return found;
  const { expense, ledger } = found;
  return {
    kind: 'picker',
    expense,
    ledger,
    categories: listActiveCategories(deps.db, ledger.id),
  };
}

export type ChangeCategoryResult =
  | { readonly kind: 'changed'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'unchanged' }
  // The category is archived or belongs to another ledger.
  | { readonly kind: 'unavailable' }
  | Refusal;

// Sets the category. A repeat of the same choice writes nothing.
export function changeCategory(
  deps: RecordDeps & Pick<KeyDeps, 'keys'>,
  input: ExpenseInput & { readonly categoryId: CategoryId; readonly now: Date },
): ChangeCategoryResult {
  const { db, logger } = deps;
  const found = editableExpense(deps, input);
  if (found.kind !== 'editable') return found;
  const { expense, stored, ledger } = found;
  const category = listActiveCategories(db, ledger.id).find((c) => c.id === input.categoryId);
  if (category === undefined) return { kind: 'unavailable' };
  const changed = isSealed(stored)
    ? expense.category?.id !== category.id &&
      resealExpense(db, stored.id, {
        sealed: resealed(deps, stored, { categoryId: category.id }),
        currency: stored.currency,
        categorySetAt: input.now,
      })
    : setExpenseCategory(db, expense.id, category.id, input.now);
  if (!changed) return { kind: 'unchanged' };
  logger.info(
    { expenseId: expense.id, categoryId: category.id, userId: input.user.id },
    'expense category changed',
  );
  return {
    kind: 'changed',
    expense: { ...expense, category: { id: category.id, name: category.name } },
    ledger,
  };
}

interface Editable {
  readonly kind: 'editable';
  readonly expense: Expense;
  readonly stored: StoredExpense;
  readonly ledger: Ledger;
}

function editableExpense(deps: Deps, input: ExpenseInput): Editable | Refusal {
  const stored = findExpenseById(deps.db, input.expenseId);
  if (stored === undefined) return { kind: 'notFound' };
  if (stored.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(deps.db, stored.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (stored.deletedAt !== null) return { kind: 'deleted' };
  const expense = openExpense(deps, stored);
  if (isLocked(expense)) return expense;
  return { kind: 'editable', expense, stored, ledger };
}
