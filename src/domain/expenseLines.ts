import type { CurrencyCode } from './currencies.js';
import { readExpenseText, type ExpenseReading, type ExpenseTextResult } from './expenseText.js';
import type { LocalDate } from './time.js';

// A multi-line message (ADR-0049): one expense per line, all or nothing. Each line is read as a
// one-line message is (readExpenseText with `forms: 'any'`), so no second grammar exists.

// The most expense lines one message records.
export const MAX_EXPENSE_LINES = 20;

export type BadLineReason = 'unreadable' | 'ambiguous' | 'future' | 'split' | 'tooManyTags';

export type ExpenseLines =
  // Fewer than two lines that read as an expense: the single-expense path reads the whole text.
  | { readonly kind: 'single' }
  // Every line a plain expense without a `/N` split, in message order.
  | { readonly kind: 'lines'; readonly lines: readonly ExpenseReading[] }
  // The first line that isn't one: its 1-based number among the non-blank lines, and its text.
  | {
      readonly kind: 'badLine';
      readonly n: number;
      readonly line: string;
      readonly reason: BadLineReason;
    }
  // A multi-line message of more than MAX_EXPENSE_LINES lines.
  | { readonly kind: 'tooMany' };

// A line counts toward the two that make a multi-line message when it reads as an expense of any
// kind: plain, split, ambiguous or dated in the future.
function readsAsExpense(reading: ExpenseTextResult): boolean {
  return (
    reading.kind === 'expense' || reading.kind === 'ambiguous' || reading.kind === 'futureDate'
  );
}

function badReason(reading: ExpenseTextResult): BadLineReason | undefined {
  switch (reading.kind) {
    case 'expense':
      return reading.split === undefined ? undefined : 'split';
    case 'ambiguous':
      return 'ambiguous';
    case 'futureDate':
      return 'future';
    case 'tooManyTags':
      return 'tooManyTags';
    case 'invalid':
    case 'notExpense':
      return 'unreadable';
  }
}

// The text's non-blank lines, trimmed: line n of a refusal is element n - 1.
export function expenseLineTexts(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// Splits on line breaks and drops blank lines. `today` is the sender's local date, which a date
// word on a line counts back from.
export function readExpenseLines(
  text: string,
  defaultCurrency: CurrencyCode,
  today: LocalDate,
): ExpenseLines {
  const lines = expenseLineTexts(text);
  if (lines.length < 2) return { kind: 'single' };
  const readings = lines.map((line) => readExpenseText(line, defaultCurrency, today, 'any'));
  const expenseLines = readings.filter(readsAsExpense).length;
  if (expenseLines < 2) return { kind: 'single' };
  // Counted over every line, so a refusal never asks to fix a line of a message still too long.
  if (lines.length > MAX_EXPENSE_LINES) return { kind: 'tooMany' };
  const plain: ExpenseReading[] = [];
  for (const [index, reading] of readings.entries()) {
    const reason = badReason(reading);
    if (reason !== undefined || reading.kind !== 'expense') {
      return {
        kind: 'badLine',
        n: index + 1,
        line: lines[index] ?? '',
        reason: reason ?? 'unreadable',
      };
    }
    plain.push(reading);
  }
  return { kind: 'lines', lines: plain };
}
