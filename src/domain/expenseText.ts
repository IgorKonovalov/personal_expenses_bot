import { currencyOfWord, GLUED_ALIASES, type CurrencyCode } from './currencies.js';
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

// `<amount>[к] [CUR] <description> [#tag…] [date]`, where CUR is an ISO code or a currency alias
// (ADR-0046), as a word or glued to the amount. The amount token runs over every digit, grouping space
// and `.`/`,` at the start, so `1 20 coffee` fails as an amount instead of recording 1 "20 coffee".
const AMOUNT_TOKEN = /^\d+(?:[ \u00A0\u2009\u202F]\d+)*(?:[.,]\d+)*/;

// A split word, `/3`: the amount is shared by MIN_SPLIT to MAX_SPLIT people.
const SPLIT_WORD = /^\/\d{1,3}$/;
export const MIN_SPLIT = 2;
export const MAX_SPLIT = 20;

// With `today` (the user's local date), the last word may name the expense's date
// (parseDateSuffix); it is then not part of the description. Without it, no word is a date.
// The amount with a `к`/`k` suffix (ADR-0046): whole units and an optional decimal fraction of
// a thousand, `1,5к` and `1.500к` both 1 500.
const THOUSANDS_TOKEN = /^(\d+)(?:[.,](\d{1,3}))?$/;

export function parseExpenseText(
  text: string,
  defaultCurrency: CurrencyCode,
  today?: LocalDate,
): ExpenseTextResult {
  const trimmed = text.trim();
  // A currency symbol or alias glued before the amount: `€300`.
  const prefix = GLUED_ALIASES.find(
    ({ alias }) =>
      trimmed.toLowerCase().startsWith(alias) && /^\d/.test(trimmed.slice(alias.length)),
  );
  const body = prefix === undefined ? trimmed : trimmed.slice(prefix.alias.length);
  const amountToken = AMOUNT_TOKEN.exec(body)?.[0];
  if (amountToken === undefined) return { kind: 'notExpense' };

  // Glued after the amount: the `к` suffix, or else a currency alias (`300€`, `2500р`). Either
  // must end at a space or the end of the text, so `500кг` stays invalid.
  let rest = body.slice(amountToken.length);
  const thousands = /^[кk](?=\s|$)/i.test(rest);
  const suffix = thousands
    ? undefined
    : GLUED_ALIASES.find(
        ({ alias }) =>
          rest.toLowerCase().startsWith(alias) && /^(?:\s|$)/.test(rest.slice(alias.length)),
      );
  if (thousands) rest = rest.slice(1);
  else if (suffix !== undefined && prefix === undefined) rest = rest.slice(suffix.alias.length);
  if (rest !== '' && !/^\s/.test(rest)) return { kind: 'invalid' };
  const gluedCurrency = prefix?.code ?? suffix?.code;

  const words = rest
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const [firstWord] = words;
  const wordCurrency =
    gluedCurrency === undefined && firstWord !== undefined ? currencyOfWord(firstWord) : undefined;
  const currency = gluedCurrency ?? wordCurrency ?? defaultCurrency;
  // A standalone `/N` word anywhere in the rest splits the amount; it isn't description.
  const afterCurrency = wordCurrency === undefined ? words : words.slice(1);
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
  const dateSuffix =
    today === undefined || lastWord === undefined
      ? ({ kind: 'none' } as const)
      : parseDateSuffix(lastWord, today);
  const description = (
    dateSuffix.kind === 'none' ? descriptionWords : descriptionWords.slice(0, -1)
  ).join(' ');
  if (description === '') return { kind: 'invalid' };
  if (tags.length > MAX_TAGS_PER_EXPENSE) return { kind: 'tooManyTags' };
  if (dateSuffix.kind === 'future') return { kind: 'futureDate', date: dateSuffix.date };
  const dated = dateSuffix.kind === 'date' ? { date: dateSuffix.date } : {};

  const amountUnits = thousands ? thousandsUnits(amountToken) : amountToken;
  if (amountUnits === undefined) return { kind: 'invalid' };
  const amount = parseAmount(amountUnits, currency);
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

// Amount-last text, `<description> <amount>[к] [CUR] [#tag…] [date]` on one line (ADR-0046):
// `Чайник 3200`, `Шкаф 45к дин`, `Краска: 2000`. It is rewritten amount-first and parsed by
// parseExpenseText, so ambiguity, a future date and too many tags read the same. Text with a `?`
// is a question, never an expense; a line break or a `/N` word makes it unreadable too.
export function readTrailingExpense(
  text: string,
  defaultCurrency: CurrencyCode,
  today?: LocalDate,
): ExpenseTextResult {
  const parts = trailingParts(text, today);
  if (parts === undefined) return { kind: 'notExpense' };
  const rewritten = [
    parts.amount,
    ...(parts.currency === undefined ? [] : [parts.currency]),
    ...parts.description,
    ...parts.tags,
    ...(parts.date === undefined ? [] : [parts.date]),
  ].join(' ');
  return parseExpenseText(rewritten, defaultCurrency, today);
}

// The words before the amount that make amount-last text read as chatter, not a purchase:
// «буду в 7», «через 10». A heuristic: it misses chatter in other shapes and flags the rare
// purchase written this way.
const CHATTER_PREPOSITIONS = new Set(['в', 'к', 'до', 'через', 'с', 'по', 'около', 'после']);

// True when the word right before the amount of amount-last text is a preposition of time or
// place. False for text readTrailingExpense can't split at all.
export function chatterShaped(text: string, today?: LocalDate): boolean {
  const before = trailingParts(text, today)?.description.at(-1);
  return before !== undefined && CHATTER_PREPOSITIONS.has(before.toLowerCase());
}

interface TrailingParts {
  readonly description: readonly string[];
  readonly amount: string;
  readonly currency?: string;
  readonly tags: readonly string[];
  readonly date?: string;
}

// Splits amount-last text at the leftmost amount-shaped word that only a currency word, tags and
// a date word follow, so in `Чайник 3200 25.09` the date is not the amount.
function trailingParts(text: string, today: LocalDate | undefined): TrailingParts | undefined {
  const trimmed = text.trim();
  if (/[\n\r?]/.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/).filter((word) => word !== '');
  if (words.some((word) => SPLIT_WORD.test(word))) return undefined;
  for (let i = 1; i < words.length; i++) {
    const amount = words[i];
    if (amount === undefined || !amountShaped(amount)) continue;
    const tail = trailingTail(words.slice(i + 1), today);
    if (tail === undefined) continue;
    // `Чайник 3 200`: a digit group before the amount would be read as description.
    if (/^\d+$/.test(words[i - 1] ?? '')) return undefined;
    const description = withoutTrailingDash(words.slice(0, i));
    if (!description.some((word) => /\p{L}/u.test(word))) return undefined;
    return { description, amount, ...tail };
  }
  return undefined;
}

// What may follow the amount, in order: one currency word, `#tag` words, one date word.
function trailingTail(
  words: readonly string[],
  today: LocalDate | undefined,
): Omit<TrailingParts, 'description' | 'amount'> | undefined {
  let next = 0;
  const first = words[0];
  const currency = first !== undefined && currencyOfWord(first) !== undefined ? first : undefined;
  if (currency !== undefined) next = 1;
  const tags: string[] = [];
  for (let word = words[next]; word !== undefined && tagOfWord(word) !== undefined;) {
    tags.push(word);
    word = words[++next];
  }
  const last = words[next];
  const date =
    last !== undefined &&
    next === words.length - 1 &&
    today !== undefined &&
    parseDateSuffix(last, today).kind !== 'none'
      ? last
      : undefined;
  if (date !== undefined) next += 1;
  if (next !== words.length) return undefined;
  return {
    ...(currency === undefined ? {} : { currency }),
    tags,
    ...(date === undefined ? {} : { date }),
  };
}

// Digits, bare or glued to a `к`/`k` suffix or a currency alias: `3200`, `1.500`, `45к`, `300€`,
// `€300`. parseExpenseText decides whether they are a valid amount.
function amountShaped(word: string): boolean {
  const lower = word.toLowerCase();
  const prefix = GLUED_ALIASES.find(
    ({ alias }) => lower.startsWith(alias) && /^\d/.test(lower.slice(alias.length)),
  );
  const body = prefix === undefined ? lower : lower.slice(prefix.alias.length);
  const digits = /^\d+(?:[.,]\d+)*/.exec(body)?.[0];
  if (digits === undefined) return false;
  const tail = body.slice(digits.length);
  return (
    tail === '' ||
    tail === 'к' ||
    tail === 'k' ||
    (prefix === undefined && GLUED_ALIASES.some(({ alias }) => alias === tail))
  );
}

// `Краска: 2000`, `Краска — 2000`: the `:`, `—` or `-` ending the description goes.
function withoutTrailingDash(words: readonly string[]): string[] {
  const last = words.at(-1);
  if (last === undefined) return [];
  const stripped = last.replace(/[:—–-]+$/, '');
  return [...words.slice(0, -1), ...(stripped === '' ? [] : [stripped])];
}

// `45` -> `45000`, `1,5` -> `1500`, `1.500` -> `1500`: whole units, as digits, for parseAmount.
function thousandsUnits(token: string): string | undefined {
  const match = THOUSANDS_TOKEN.exec(token);
  if (match === null) return undefined;
  const [, whole = '', fraction = ''] = match;
  return whole + fraction.padEnd(3, '0');
}
