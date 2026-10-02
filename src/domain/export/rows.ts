import type { CurrencyCode } from '../currencies.js';
import type { Money } from '../money.js';
import { monthOf, previous, type DateRange } from '../periods.js';
import type { LocalDate } from '../time.js';

// The tables an export holds (ADR-0026). The writers receive these and know nothing of ledgers,
// receipts or Telegram; each renders an `amount` cell from minor units in its own decimal form.

export type ExportCell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'amount'; readonly minor: number; readonly currency: CurrencyCode }
  | { readonly kind: 'empty' };

export interface ExportColumn {
  readonly header: string;
}

export interface ExportTable {
  // The sheet name, or the file stem.
  readonly name: string;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly (readonly ExportCell[])[];
}

export type ExportRange = 'tm' | 'pm' | 'ty' | 'all';
export const EXPORT_RANGES: readonly ExportRange[] = ['tm', 'pm', 'ty', 'all'];

export function isExportRange(value: string): value is ExportRange {
  return (EXPORT_RANGES as readonly string[]).includes(value);
}

export interface ExportSpan {
  // What the file is named by: `2026-10`, `2026-09`, `2026` or `all`.
  readonly key: string;
  // The occurred_on dates covered, both ends inclusive; absent for all time.
  readonly dates?: DateRange;
}

// A range's calendar dates from the ledger's local today: this month is the 1st through today,
// last month the whole previous month, this year 1 January through today.
export function exportSpan(range: ExportRange, today: LocalDate): ExportSpan {
  switch (range) {
    case 'tm':
      return { key: today.slice(0, 7), dates: { from: monthOf(today).from, to: today } };
    case 'pm': {
      const { from, to } = previous(monthOf(today));
      return { key: from.slice(0, 7), dates: { from, to } };
    }
    case 'ty':
      return {
        key: today.slice(0, 4),
        dates: { from: `${today.slice(0, 4)}-01-01` as LocalDate, to: today },
      };
    case 'all':
      return { key: 'all' };
  }
}

// One exported expense, already opened and resolved by the service.
export interface ExportExpense {
  readonly id: string;
  readonly occurredOn: LocalDate;
  readonly amount: Money;
  readonly category: string | null;
  readonly description: string;
}

export interface ExpenseHeaders {
  readonly date: string;
  readonly amount: string;
  readonly currency: string;
  readonly category: string;
  readonly description: string;
}

// The expenses table, one row per expense in the order given.
export function expensesTable(
  name: string,
  headers: ExpenseHeaders,
  expenses: readonly ExportExpense[],
): ExportTable {
  return {
    name,
    columns: [
      headers.date,
      headers.amount,
      headers.currency,
      headers.category,
      headers.description,
    ].map((header) => ({ header })),
    rows: expenses.map((expense) => [
      text(expense.occurredOn),
      amount(expense.amount),
      text(expense.amount.currency),
      optionalText(expense.category),
      text(expense.description),
    ]),
  };
}

function text(value: string): ExportCell {
  return { kind: 'text', value };
}

function optionalText(value: string | null): ExportCell {
  return value === null || value === '' ? EMPTY : text(value);
}

function amount({ amountMinor, currency }: Money): ExportCell {
  return { kind: 'amount', minor: amountMinor, currency };
}

const EMPTY: ExportCell = { kind: 'empty' };
