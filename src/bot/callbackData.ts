import type { CategoryId } from '../db/categories.js';
import type { ExpenseId } from '../db/expenses.js';

// Telegram rejects callback_data over 64 bytes (UTF-8). Format: `<scope>:<action>[:<arg>…]`,
// built only here (ADR-0011).
const MAX_CALLBACK_DATA_BYTES = 64;

export function assertCallbackData(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data is ${bytes} bytes; Telegram allows ${MAX_CALLBACK_DATA_BYTES}`);
  }
  return data;
}

// Expense-card actions work on any card, however old: the expense's stored state is the guard.
export const UNDO_EXPENSE = /^exp:undo:([0-9a-f-]{36})$/;
export const RESTORE_EXPENSE = /^exp:restore:([0-9a-f-]{36})$/;

export function undoExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:undo:${expenseId}`);
}

// A reading of an ambiguous amount: `amb:t` thousands, `amb:d` decimal. The amount itself isn't
// in the data; the tap re-parses the message the question replies to.
export const AMBIGUOUS_READING = /^amb:([td])$/;

export function ambiguousReadingData(interpretation: 'thousands' | 'decimal'): string {
  return assertCallbackData(`amb:${interpretation === 'thousands' ? 't' : 'd'}`);
}

export function restoreExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:restore:${expenseId}`);
}

// The category picker, edited into the card in place. Pages are 1-based. A category id is a
// short integer (ADR-0007), so `exp:setcat:<uuid>:<id>` fits for ids of up to 16 digits.
export const CATEGORY_PICKER = /^exp:cat:([0-9a-f-]{36})$/;
export const CATEGORY_PAGE = /^exp:catp:([0-9a-f-]{36}):(\d{1,4})$/;
export const SET_CATEGORY = /^exp:setcat:([0-9a-f-]{36}):(\d{1,16})$/;
export const SHOW_EXPENSE = /^exp:show:([0-9a-f-]{36})$/;

export function categoryPickerData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:cat:${expenseId}`);
}

export function categoryPageData(expenseId: ExpenseId, page: number): string {
  return assertCallbackData(`exp:catp:${expenseId}:${page}`);
}

export function setCategoryData(expenseId: ExpenseId, categoryId: CategoryId): string {
  return assertCallbackData(`exp:setcat:${expenseId}:${categoryId}`);
}

export function showExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:show:${expenseId}`);
}
