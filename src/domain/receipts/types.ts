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

export type DecodeReceiptResult =
  | { readonly kind: 'receipt'; readonly receipt: DecodedReceipt }
  | { readonly kind: 'refused'; readonly reason: ReceiptRefusal }
  // Not a receipt verification URL at all.
  | { readonly kind: 'notReceipt' };
