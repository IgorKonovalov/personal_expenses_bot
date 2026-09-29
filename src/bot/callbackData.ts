import type { ExpenseId } from '../db/expenses.js';

// Telegram rejects callback_data over 64 bytes (UTF-8). Format: `<scope>:<action>:<arg>`.
const MAX_CALLBACK_DATA_BYTES = 64;

export function assertCallbackData(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data is ${bytes} bytes; Telegram allows ${MAX_CALLBACK_DATA_BYTES}`);
  }
  return data;
}

export const UNDO_EXPENSE = /^exp:undo:([0-9a-f-]{36})$/;

export function undoExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:undo:${expenseId}`);
}
