import { toCurrencyCode, type CurrencyCode } from './currencies.js';
import { parseAmount, type AmountReading } from './money.js';

export type ExpenseTextResult =
  | {
      readonly kind: 'expense';
      readonly amountMinor: number;
      readonly currency: CurrencyCode;
      readonly description: string;
    }
  | {
      readonly kind: 'ambiguous';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
      readonly description: string;
    }
  // Starts like an amount but is not a valid one, or has no description.
  | { readonly kind: 'invalid' }
  // Does not start with an amount at all.
  | { readonly kind: 'notExpense' };

// `<amount> [CUR] <description>`. The amount token runs over every digit, grouping space and
// `.`/`,` at the start, so `1 20 coffee` fails as an amount instead of recording 1 "20 coffee".
const AMOUNT_TOKEN = /^\d+(?:[ \u00A0\u2009\u202F]\d+)*(?:[.,]\d+)*/;

export function parseExpenseText(text: string, defaultCurrency: CurrencyCode): ExpenseTextResult {
  const trimmed = text.trim();
  const amountToken = AMOUNT_TOKEN.exec(trimmed)?.[0];
  if (amountToken === undefined) return { kind: 'notExpense' };

  const rest = trimmed.slice(amountToken.length);
  if (rest !== '' && !/^\s/.test(rest)) return { kind: 'invalid' };

  const words = rest
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const [firstWord] = words;
  const namedCurrency =
    firstWord !== undefined && /^[A-Za-z]{3}$/.test(firstWord)
      ? toCurrencyCode(firstWord)
      : undefined;
  const currency = namedCurrency ?? defaultCurrency;
  const description = (namedCurrency === undefined ? words : words.slice(1)).join(' ');
  if (description === '') return { kind: 'invalid' };

  const amount = parseAmount(amountToken, currency);
  switch (amount.kind) {
    case 'ok':
      return { kind: 'expense', amountMinor: amount.amountMinor, currency, description };
    case 'ambiguous':
      return { kind: 'ambiguous', readings: amount.readings, currency, description };
    case 'invalid':
      return { kind: 'invalid' };
  }
}
