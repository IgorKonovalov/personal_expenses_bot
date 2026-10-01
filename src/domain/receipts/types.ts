// A fiscal receipt as its QR code's verification URL describes it, read offline (ADR-0018).

export type ReceiptCountry = 'RS' | 'ME';

export interface DecodedReceipt {
  readonly country: ReceiptCountry;
  // RS: the invoice number `requestedBy-signedBy-totalCounter`. ME: the iic, lowercased.
  readonly fiscalId: string;
  // The shop a receipt came from: `rs:<requestedBy>` or `me:<tin>:<bu>`.
  readonly merchantKey: string;
  // Integer minor units of `currency`.
  readonly totalMinor: number;
  readonly currency: 'RSD' | 'EUR';
  readonly issuedAt: Date;
  // The canonical verification URL the fetcher calls. Expense data: never logged above debug.
  readonly verifyUrl: string;
}

// Why a receipt URL records nothing.
export type ReceiptRefusal =
  // Not decodable: truncated, bad encoding, a failed checksum or a field out of range.
  | 'malformed'
  // A total the currency's minor units can't hold exactly.
  | 'fractionalTotal'
  // A pro-forma, copy, training or advance invoice: not a sale.
  | 'notSale'
  | 'refund';

// What the tax authority's site adds to a receipt (ADR-0018). Expense data: never logged.
export interface FetchedReceipt {
  readonly sellerName: string;
  // The site's total, in minor units of the receipt's currency; compared, never stored.
  readonly totalMinor: number;
  // The currency the site names, when it names one.
  readonly currencyCode?: string;
  readonly items: readonly FetchedItem[];
}

export interface FetchedItem {
  readonly name: string;
  // The quantity's decimal source text, e.g. `0.535`: not money.
  readonly quantity: string;
  readonly totalMinor: number;
}

export type DecodeReceiptResult =
  | { readonly kind: 'receipt'; readonly receipt: DecodedReceipt }
  | { readonly kind: 'refused'; readonly reason: ReceiptRefusal }
  // Not a receipt verification URL at all.
  | { readonly kind: 'notReceipt' };
