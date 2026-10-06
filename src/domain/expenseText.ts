import { toCurrencyCode, type CurrencyCode } from './currencies.js';
import { parseDateSuffix } from './dateText.js';
import { parseAmount, type AmountReading } from './money.js';
import { MAX_TAGS_PER_EXPENSE, tagOfWord, uniqueTags, type TagName } from './tags.js';
import type { LocalDate } from './time.js';

export type ExpenseTextResult =
  | {
      readonly kind: 'expense';
      readonly amountMinor: number;
      readonly currency: CurrencyCode;
      readonly description: string;
      // The date the last word named; absent when the text names none.
      readonly date?: LocalDate;
      // A `/N` word: the amount is split N ways.
      readonly split?: number;
      // The `#tag` words, normalized, first-seen order, each once (ADR-0029).
      readonly tags: readonly TagName[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly readings: readonly AmountReading[];
      readonly currency: CurrencyCode;
      readonly description: string;
      readonly date?: LocalDate;
      readonly split?: number;
      readonly tags: readonly TagName[];
    }
  // Starts like an amount but is not a valid one, or has no description.
  | { readonly kind: 'invalid' }
  // More than MAX_TAGS_PER_EXPENSE distinct tags.
  | { readonly kind: 'tooManyTags' }
  // Names a literal date after today.
  | { readonly kind: 'futureDate'; readonly date: LocalDate }
  // Does not start with an amount at all.
  | { readonly kind: 'notExpense' };

// `<amount> [CUR] <description> [#tag…] [date]`. The amount token runs over every digit, grouping space
// and `.`/`,` at the start, so `1 20 coffee` fails as an amount instead of recording 1 "20 coffee".
const AMOUNT_TOKEN = /^\d+(?:[ \u00A0\u2009\u202F]\d+)*(?:[.,]\d+)*/;

// A split word, `/3`: the amount is shared by MIN_SPLIT to MAX_SPLIT people.
const SPLIT_WORD = /^\/\d{1,3}$/;
export const MIN_SPLIT = 2;
export const MAX_SPLIT = 20;

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
  // A standalone `/N` word anywhere in the rest splits the amount; it isn't description.
  const afterCurrency = namedCurrency === undefined ? words : words.slice(1);
  const splitWords = afterCurrency.filter((word) => SPLIT_WORD.test(word));
  if (splitWords.length > 1) return { kind: 'invalid' };
  const split = splitWords[0] === undefined ? undefined : Number(splitWords[0].slice(1));
  if (split !== undefined && (split < MIN_SPLIT || split > MAX_SPLIT)) return { kind: 'invalid' };
  const splitPart = split === undefined ? {} : { split };
  // `#tag` words come out before the date suffix is read, so `450 такси #рим вчера` is dated.
  const restWords = afterCurrency.filter((word) => !SPLIT_WORD.test(word));
  const tags = uniqueTags(restWords.flatMap((word) => tagOfWord(word) ?? []));
  const descriptionWords = restWords.filter((word) => tagOfWord(word) === undefined);

  const lastWord = descriptionWords.at(-1);
  const suffix =
    today === undefined || lastWord === undefined
      ? ({ kind: 'none' } as const)
      : parseDateSuffix(lastWord, today);
  const description = (
    suffix.kind === 'none' ? descriptionWords : descriptionWords.slice(0, -1)
  ).join(' ');
  if (description === '') return { kind: 'invalid' };
  if (tags.length > MAX_TAGS_PER_EXPENSE) return { kind: 'tooManyTags' };
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
        ...splitPart,
        tags,
      };
    case 'ambiguous':
      return {
        kind: 'ambiguous',
        readings: amount.readings,
        currency,
        description,
        ...dated,
        ...splitPart,
        tags,
      };
    case 'invalid':
      return { kind: 'invalid' };
  }
}
