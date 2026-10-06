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
  // `HH:MM` of occurred_at in the ledger's timezone.
  readonly time: string;
  readonly amount: Money;
  // In the ledger's currency at the NBS rate of occurredOn (ADR-0022); undefined with no rate.
  readonly converted: Money | undefined;
  readonly category: string | null;
  readonly description: string;
  // Normalized names without `#`, first-written order (ADR-0029).
  readonly tags: readonly string[];
  // The author's display name; null for a member with none. Read only for a shared ledger.
  readonly author: string | null;
  // The receipt's shop and fiscal link; null without a receipt, or before the shop is known.
  readonly shop: string | null;
  readonly receiptUrl: string | null;
}

// One line item of an exported expense's receipt.
export interface ExportItem {
  readonly expenseId: string;
  readonly occurredOn: LocalDate;
  readonly shop: string | null;
  // 1-based, in the order the tax site lists them.
  readonly position: number;
  readonly name: string;
  // Decimal source text, e.g. `0.535`: a quantity, not money.
  readonly quantity: string;
  readonly total: Money;
}

export interface ExpenseLabels {
  readonly date: string;
  readonly time: string;
  readonly amount: string;
  readonly currency: string;
  readonly converted: string;
  readonly category: string;
  readonly description: string;
  readonly tags: string;
  readonly author: string;
  readonly shop: string;
  readonly receipt: string;
  readonly id: string;
  // The Автор cell for a member with no display name.
  readonly unnamedAuthor: string;
}

// The expenses table, one row per expense in the order given. The author column exists only
// `withAuthor`, for a shared ledger.
export function expensesTable(
  name: string,
  labels: ExpenseLabels,
  expenses: readonly ExportExpense[],
  withAuthor: boolean,
): ExportTable {
  const headers = [
    labels.date,
    labels.time,
    labels.amount,
    labels.currency,
    labels.converted,
    labels.category,
    labels.description,
    labels.tags,
    ...(withAuthor ? [labels.author] : []),
    labels.shop,
    labels.receipt,
    labels.id,
  ];
  return {
    name,
    columns: headers.map((header) => ({ header })),
    rows: expenses.map((expense) => [
      text(expense.occurredOn),
      text(expense.time),
      amount(expense.amount),
      text(expense.amount.currency),
      expense.converted === undefined ? EMPTY : amount(expense.converted),
      optionalText(expense.category),
      text(expense.description),
      // `#отпуск #рим`; empty for none.
      optionalText(
        expense.tags.length === 0 ? null : expense.tags.map((tag) => `#${tag}`).join(' '),
      ),
      ...(withAuthor ? [text(expense.author ?? labels.unnamedAuthor)] : []),
      optionalText(expense.shop),
      optionalText(expense.receiptUrl),
      text(expense.id),
    ]),
  };
}

export interface ItemLabels {
  readonly expenseId: string;
  readonly date: string;
  readonly shop: string;
  readonly position: string;
  readonly name: string;
  readonly quantity: string;
  readonly amount: string;
  readonly currency: string;
}

// The receipt items table, one row per item in the order given. The quantity keeps its digits,
// with a decimal comma.
export function itemsTable(
  name: string,
  labels: ItemLabels,
  items: readonly ExportItem[],
): ExportTable {
  return {
    name,
    columns: [
      labels.expenseId,
      labels.date,
      labels.shop,
      labels.position,
      labels.name,
      labels.quantity,
      labels.amount,
      labels.currency,
    ].map((header) => ({ header })),
    rows: items.map((item) => [
      text(item.expenseId),
      text(item.occurredOn),
      optionalText(item.shop),
      text(String(item.position)),
      text(item.name),
      text(item.quantity.replace('.', ',')),
      amount(item.total),
      text(item.total.currency),
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
