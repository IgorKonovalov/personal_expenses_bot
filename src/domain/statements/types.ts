import type { CurrencyCode } from '../currencies.js';
import type { LocalDate } from '../time.js';

// A PDF page's text as the statements adapter reads it (ADR-0033): the text items sharing a
// baseline, each kept as a cell at its x. Pages are 1-based; y grows down the page.
export interface PositionedLine {
  readonly page: number;
  readonly y: number;
  // Sorted by x.
  readonly cells: readonly PositionedCell[];
}

export interface PositionedCell {
  readonly x: number;
  readonly text: string;
}

// A card purchase read from a statement row.
export interface StatementPurchase {
  // The transaction date, a local date in the bank's country.
  readonly date: LocalDate;
  // The original amount and currency (ADR-0021's choice for SMS).
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  // The row's description, wrapped lines joined and whitespace collapsed.
  readonly merchant: string;
  // The debit in the account currency, shown in the preview and never stored.
  readonly debitRsdMinor: number;
  // 0 for the first of identical (date, amount, currency, merchant) rows, then 1, 2…
  readonly ordinal: number;
}

export interface StatementPeriod {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export type ParseStatementResult =
  | {
      readonly kind: 'statement';
      readonly period: StatementPeriod | undefined;
      readonly purchases: readonly StatementPurchase[];
    }
  | { readonly kind: 'notThisStatement' };
