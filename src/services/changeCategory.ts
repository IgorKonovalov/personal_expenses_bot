import { listActiveCategories, type Category, type CategoryId } from '../db/categories.js';
import {
  findExpenseById,
  setExpenseCategory,
  type Expense,
  type ExpenseId,
} from '../db/expenses.js';
import { findLedgerForMember, type Ledger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import type { RecordDeps } from './recordExpense.js';

// Changing an expense's category from its card (ADR-0011). The expense's stored state is the
// guard: only its creator may change it, and only while it isn't deleted. The change is also
// the learning signal of ADR-0008: the corrected expense is what the history step matches.

interface ExpenseInput {
  readonly user: User;
  readonly expenseId: ExpenseId;
}

type Refusal =
  { readonly kind: 'notFound' } | { readonly kind: 'forbidden' } | { readonly kind: 'deleted' };

export type ShowExpenseResult =
  | { readonly kind: 'card'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'notFound' };

// The expense for its card, to any member of its ledger. Read-only.
export function showExpense(
  { db }: Pick<RecordDeps, 'db'>,
  input: ExpenseInput,
): ShowExpenseResult {
  const expense = findExpenseById(db, input.expenseId);
  const ledger =
    expense === undefined ? undefined : findLedgerForMember(db, expense.ledgerId, input.user.id);
  if (expense === undefined || ledger === undefined) return { kind: 'notFound' };
  return { kind: 'card', expense, ledger };
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
export function openCategoryPicker(
  { db }: Pick<RecordDeps, 'db'>,
  input: ExpenseInput,
): CategoryPickerResult {
  const found = editableExpense(db, input);
  if (found.kind !== 'editable') return found;
  const { expense, ledger } = found;
  return { kind: 'picker', expense, ledger, categories: listActiveCategories(db, ledger.id) };
}

export type ChangeCategoryResult =
  | { readonly kind: 'changed'; readonly expense: Expense; readonly ledger: Ledger }
  | { readonly kind: 'unchanged' }
  // The category is archived or belongs to another ledger.
  | { readonly kind: 'unavailable' }
  | Refusal;

// Sets the category. A repeat of the same choice writes nothing.
export function changeCategory(
  deps: RecordDeps,
  input: ExpenseInput & { readonly categoryId: CategoryId; readonly now: Date },
): ChangeCategoryResult {
  const { db, logger } = deps;
  const found = editableExpense(db, input);
  if (found.kind !== 'editable') return found;
  const { expense, ledger } = found;
  const category = listActiveCategories(db, ledger.id).find((c) => c.id === input.categoryId);
  if (category === undefined) return { kind: 'unavailable' };
  if (!setExpenseCategory(db, expense.id, category.id, input.now)) return { kind: 'unchanged' };
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

function editableExpense(
  db: RecordDeps['db'],
  input: ExpenseInput,
): { readonly kind: 'editable'; readonly expense: Expense; readonly ledger: Ledger } | Refusal {
  const expense = findExpenseById(db, input.expenseId);
  if (expense === undefined) return { kind: 'notFound' };
  if (expense.createdBy !== input.user.id) return { kind: 'forbidden' };
  const ledger = findLedgerForMember(db, expense.ledgerId, input.user.id);
  if (ledger === undefined) return { kind: 'forbidden' };
  if (expense.deletedAt !== null) return { kind: 'deleted' };
  return { kind: 'editable', expense, ledger };
}
