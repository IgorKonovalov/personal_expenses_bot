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
