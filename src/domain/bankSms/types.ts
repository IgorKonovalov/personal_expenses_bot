import type { CurrencyCode } from '../currencies.js';

// A bank's card-purchase SMS, read by the parser of its template (ADR-0021).

export type BankSmsTemplate = 'koriscenje-kartice';

export interface BankSmsPurchase {
  readonly kind: 'purchase';
  readonly template: BankSmsTemplate;
  // The bank's wall time, as a UTC instant.
  readonly issuedAt: Date;
  // Integer minor units of `currency`, > 0.
  readonly amountMinor: number;
  // The charged currency, which may differ from the card's.
  readonly currency: CurrencyCode;
  // The merchant, cleaned up. Expense data: never logged above debug.
  readonly description: string;
  // SHA-256 hex of the normalised fields: the same SMS, however pasted, gives the same value.
  readonly fingerprint: string;
}

// Why an SMS whose header matched records nothing.
export type BankSmsRefusal =
  // A required line is missing, or its value breaks the template: a bad date, an amount out of
  // pattern, zero, or more fraction digits than the currency holds.
  | { readonly kind: 'refused'; readonly reason: 'malformed' }
  // A well-formed three-letter code the currency table doesn't have.
  | { readonly kind: 'refused'; readonly reason: 'unsupportedCurrency'; readonly code: string };

export type BankSmsResult =
  | BankSmsPurchase
  | BankSmsRefusal
  // Not an SMS of any template we read.
  | { readonly kind: 'notBankSms' };
