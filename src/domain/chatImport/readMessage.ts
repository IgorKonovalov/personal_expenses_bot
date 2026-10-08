import {
  currencyExponent,
  currencyOfWord,
  GLUED_ALIASES,
  type CurrencyCode,
} from '../currencies.js';
import {
  chatterShaped,
  parseExpenseText,
  readTrailingExpense,
  type ExpenseTextResult,
} from '../expenseText.js';
import type { AmountReading, Money } from '../money.js';
import type { LocalDate } from '../time.js';

// One message of a group's history (ADR-0047) split into the expenses it proposes, and a verdict:
// `ready` to record with the rest in one tap, `review` to be looked at, or `noAmount`.

export interface ProposedItem {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly description: string;
  readonly occurredOn: LocalDate;
}

// An item whose amount reads two ways (`Лампа 1.500`): a person picks the reading (ADR-0004).
export interface AmbiguousItem {
  readonly readings: readonly AmountReading[];
  readonly currency: CurrencyCode;
  readonly description: string;
  readonly occurredOn: LocalDate;
}

export type ReadItem = ProposedItem | AmbiguousItem;

export function isAmbiguousItem(item: ReadItem): item is AmbiguousItem {
  return 'readings' in item;
}

export type ReviewReason =
  'total' | 'bare' | 'unread' | 'ambiguous' | 'prefix' | 'forwarded' | 'deletedSender';

export type MessageRead =
  | { readonly verdict: 'ready'; readonly items: readonly ProposedItem[] }
  | {
      readonly verdict: 'review';
      readonly reason: ReviewReason;
      // What the lines that did read propose, total lines left out.
      readonly items: readonly ReadItem[];
      // `total`: the first total line the items don't add up to.
      readonly stated?: Money;
      // The name the message starts with, when it does.
      readonly prefix?: string;
    }
  | { readonly verdict: 'noAmount' };

// What the export says about the message beyond its text.
export interface MessageContext {
  readonly forwarded?: boolean;
  readonly deletedSender?: boolean;
  // The name prefix was answered as a name: the message reads without it, and the prefix alone
  // sends it to no review.
  readonly prefixAnswered?: boolean;
}

// Splits the message into lines, and a line into `, `/`; `-separated pieces when every piece
// reads as an item. A line or piece reads amount-first (parseExpenseText), then amount-last
// (readTrailingExpense); an amount alone, or «итого»/«всего»/«итог» and an amount, is a total.
// `today` is the message's local date in the ledger's timezone, so a date word counts back from
// it. A `/N` split or a future date leaves the line unread. The lines after a name prefix are read
// without it.
export function readMessage(
  text: string,
  defaultCurrency: CurrencyCode,
  today: LocalDate,
  context: MessageContext = {},
): MessageRead {
  if (!/\d/.test(text)) return { verdict: 'noAmount' };
  const prefixed = namePrefix(text, defaultCurrency, today);
  const lines = (prefixed?.rest ?? text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const reads = lines.map((line) => readLine(line, defaultCurrency, today));
  const items = reads.flatMap((read) => (read.kind === 'items' ? read.items : []));
  const mismatch = reads.find(
    (read): read is TotalLine => read.kind === 'total' && !addsUpTo(items, read.total),
  );

  const reason: ReviewReason | undefined =
    context.deletedSender === true
      ? 'deletedSender'
      : context.forwarded === true
        ? 'forwarded'
        : prefixed !== undefined && context.prefixAnswered !== true
          ? 'prefix'
          : items.length === 0 || reads.some((read) => read.kind === 'unread')
            ? 'unread'
            : items.some(isAmbiguousItem)
              ? 'ambiguous'
              : mismatch !== undefined
                ? 'total'
                : reads.some((read) => read.kind === 'items' && read.bare)
                  ? 'bare'
                  : undefined;
  if (reason === undefined) {
    return {
      verdict: 'ready',
      items: items.filter((item): item is ProposedItem => !isAmbiguousItem(item)),
    };
  }
  return {
    verdict: 'review',
    reason,
    items,
    ...(reason === 'total' && mismatch !== undefined ? { stated: mismatch.total } : {}),
    ...(prefixed === undefined ? {} : { prefix: prefixed.prefix }),
  };
}

// A message that starts with a name: one word, then `:`, then text whose first line reads as an
// item with a description (`Ира: ремонт 300€`). `Шкаф: 4500` has none: «4500» has no description.
export function namePrefix(
  text: string,
  defaultCurrency: CurrencyCode,
  today: LocalDate,
): { readonly prefix: string; readonly rest: string } | undefined {
  const match = /^\s*(\p{L}[\p{L}-]*):[ \t]+(\S[\s\S]*)$/u.exec(text);
  if (match === null) return undefined;
  const [, prefix = '', rest = ''] = match;
  const [firstLine = ''] = rest.split(/\r?\n/);
  if (readItem(firstLine.trim(), defaultCurrency, today) === undefined) return undefined;
  return { prefix, rest };
}

interface ItemsLine {
  readonly kind: 'items';
  readonly items: readonly ReadItem[];
  // An amount-last item that may be chatter (see isBare).
  readonly bare: boolean;
}

interface TotalLine {
  readonly kind: 'total';
  readonly total: Money;
}

type LineRead = ItemsLine | TotalLine | { readonly kind: 'unread' };

function readLine(line: string, currency: CurrencyCode, today: LocalDate): LineRead {
  const total = totalOf(line, currency);
  if (total !== undefined) return { kind: 'total', total };
  if (/[,;] /.test(line)) {
    const pieces = line
      .split(/[,;] /)
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '');
    const read = pieces.map((piece) => readItem(piece, currency, today));
    if (pieces.length > 1 && read.every((item) => item !== undefined)) return itemsLine(read);
  }
  const item = readItem(line, currency, today);
  return item === undefined ? { kind: 'unread' } : itemsLine([item]);
}

function itemsLine(read: readonly { item: ReadItem; bare: boolean }[]): ItemsLine {
  return {
    kind: 'items',
    items: read.map(({ item }) => item),
    bare: read.some(({ bare }) => bare),
  };
}

function readItem(
  piece: string,
  currency: CurrencyCode,
  today: LocalDate,
): { item: ReadItem; bare: boolean } | undefined {
  const leading = parseExpenseText(piece, currency, today);
  if (leading.kind !== 'notExpense') {
    const item = itemOf(leading, today);
    return item === undefined ? undefined : { item, bare: false };
  }
  const item = itemOf(readTrailingExpense(piece, currency, today), today);
  if (item === undefined) return undefined;
  return { item, bare: isBare(piece, item, today) };
}

function itemOf(parsed: ExpenseTextResult, today: LocalDate): ReadItem | undefined {
  if (parsed.kind !== 'expense' && parsed.kind !== 'ambiguous') return undefined;
  if (parsed.split !== undefined) return undefined;
  const base = {
    currency: parsed.currency,
    description: withoutTrailingPreposition(parsed.description),
    occurredOn: parsed.date ?? today,
  };
  return parsed.kind === 'expense'
    ? { amountMinor: parsed.amountMinor, ...base }
    : { readings: parsed.readings, ...base };
}

// A heuristic, to keep chatter like «буду в 7» out of the bulk record: an amount-last item that
// names no currency and has no `к`, and either reads as chatter (chatterShaped) or is under 100
// whole units. It misses chatter in other shapes and flags the odd small purchase.
const BARE_UNDER_UNITS = 100;

function isBare(piece: string, item: ReadItem, today: LocalDate): boolean {
  if (namesCurrency(piece) || /\d[кk](?=\s|$)/iu.test(piece)) return false;
  if (chatterShaped(piece, today)) return true;
  const limit = BARE_UNDER_UNITS * 10 ** currencyExponent(item.currency);
  return isAmbiguousItem(item)
    ? item.readings.every((reading) => reading.amountMinor < limit)
    : item.amountMinor < limit;
}

// A currency word (`дин`, `EUR`), or an alias glued to the amount (`300€`, `€300`).
function namesCurrency(piece: string): boolean {
  return piece
    .split(/\s+/)
    .some(
      (word) =>
        currencyOfWord(word) !== undefined ||
        (/\d/.test(word) &&
          GLUED_ALIASES.some(
            ({ alias }) =>
              word.toLowerCase().startsWith(alias) || word.toLowerCase().endsWith(alias),
          )),
    );
}

// `валиков на 800`: the «на» or «за» left before the amount is not part of the description.
function withoutTrailingPreposition(description: string): string {
  const words = description.split(' ');
  const last = words.at(-1)?.toLowerCase();
  return words.length > 1 && (last === 'на' || last === 'за')
    ? words.slice(0, -1).join(' ')
    : description;
}

const TOTAL_WORD = /^(?:итого|всего|итог)\s*:?\s*/iu;
// The description parseExpenseText reads off a total line it is handed.
const TOTAL_PROBE = 'итого';

// An amount alone (`3300 дин`, `€300`, `45к`), or a total word and an amount. An ambiguous
// amount is no total.
function totalOf(line: string, currency: CurrencyCode): Money | undefined {
  const rest = line.replace(TOTAL_WORD, '');
  if (!/^\S*\d/.test(rest)) return undefined;
  const parsed = parseExpenseText(`${rest} ${TOTAL_PROBE}`, currency);
  if (parsed.kind !== 'expense' || parsed.description !== TOTAL_PROBE) return undefined;
  if (parsed.split !== undefined || parsed.tags.length > 0) return undefined;
  return { amountMinor: parsed.amountMinor, currency: parsed.currency };
}

// Every item is definite, in the total's currency, and they sum to it.
function addsUpTo(items: readonly ReadItem[], total: Money): boolean {
  let sum = 0;
  for (const item of items) {
    if (isAmbiguousItem(item) || item.currency !== total.currency) return false;
    sum += item.amountMinor;
  }
  return items.length > 0 && sum === total.amountMinor;
}
