import { toCurrencyCode, type CurrencyCode } from './currencies.js';
import { parseDateSuffix } from './dateText.js';
import { parseAmount, type AmountReading } from './money.js';
import type { LocalDate } from './time.js';

export type ExpenseTextResult =
  | {
      readonly kind: 'expense';
      readonly amountMinor: number;
      readonly currency: CurrencyCode;
      readonly description: string;
      // The date the last word named; absent when the text names none.
      readonly date?: LocalDate;
    }
  | {
      readonly kind: 'ambiguous';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
      readonly description: string;
      readonly date?: LocalDate;
    }
  // Starts like an amount but is not a valid one, or has no description.
  | { readonly kind: 'invalid' }
  // Names a literal date after today.
  | { readonly kind: 'futureDate'; readonly date: LocalDate }
  // Does not start with an amount at all.
  | { readonly kind: 'notExpense' };

// `<amount> [CUR] <description> [date]`. The amount token runs over every digit, grouping space
// and `.`/`,` at the start, so `1 20 coffee` fails as an amount instead of recording 1 "20 coffee".
const AMOUNT_TOKEN = /^\d+(?:[ \u00A0\u2009\u202F]\d+)*(?:[.,]\d+)*/;

// With `today` (the user's local date), the last word may name the expense's date
// (parseDateSuffix); it is then not part of the description. Without it, no word is a date.
export function parseExpenseText(
  text: string,
  defaultCurrency: CurrencyCode,
  today?: LocalDate,
): ExpenseTextResult {
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
  const descriptionWords = namedCurrency === undefined ? words : words.slice(1);

  const lastWord = descriptionWords.at(-1);
  const suffix =
    today === undefined || lastWord === undefined
      ? ({ kind: 'none' } as const)
      : parseDateSuffix(lastWord, today);
  const description = (
    suffix.kind === 'none' ? descriptionWords : descriptionWords.slice(0, -1)
  ).join(' ');
  if (description === '') return { kind: 'invalid' };
  if (suffix.kind === 'future') return { kind: 'futureDate', date: suffix.date };
  const dated = suffix.kind === 'date' ? { date: suffix.date } : {};

  const amount = parseAmount(amountToken, currency);
  switch (amount.kind) {
    case 'ok':
      return {
        kind: 'expense',
        amountMinor: amount.amountMinor,
        currency,
        description,
        ...dated,
      };
    case 'ambiguous':
      return { kind: 'ambiguous', readings: amount.readings, currency, description, ...dated };
    case 'invalid':
      return { kind: 'invalid' };
  }
}
