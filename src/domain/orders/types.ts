import type { FetchedItem } from '../receipts/types.js';

// A wall-clock time in the order's own timezone, `YYYY-MM-DD HH:MM`.
export type LocalDateTime = string & { readonly __brand: 'LocalDateTime' };

// A delivery order read from its confirmation PDF (ADR-0052). It never holds the customer's
// name or the card digits: the parser doesn't read them. Expense data: never logged.
export interface DeliveryOrder {
  readonly source: 'wolt-rs';
  // 24 hex characters.
  readonly orderId: string;
  // «Lokacija»: the restaurant, the expense's description.
  readonly restaurant: string;
  // The seller's PIB.
  readonly sellerTaxId: string;
  readonly deliveredAt: LocalDateTime;
  // Integer minor units of `currency`.
  readonly totalMinor: number;
  readonly currency: 'RSD';
  readonly items: readonly FetchedItem[];
}

export type ParseOrderResult =
  | { readonly kind: 'order'; readonly order: DeliveryOrder }
  // Recognised as an order, but a check failed: nothing is guessed.
  | { readonly kind: 'unreadableOrder' }
  | { readonly kind: 'notThisOrder' };
