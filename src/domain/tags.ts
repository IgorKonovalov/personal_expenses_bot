import { summarizeConverted, type DatedMoney } from './aggregate.js';
import type { CurrencyCode } from './currencies.js';
import type { RateOf } from './fx.js';
import type { Money } from './money.js';
import type { LocalDate } from './time.js';

// A tag's name as stored and shown without its `#` (ADR-0029): NFC, lower case, 1 to 32
// letters, digits or `_`.
export type TagName = string & { readonly __brand: 'TagName' };

export const MAX_TAGS_PER_EXPENSE = 5;

const TAG_NAME = /^[\p{L}\p{N}_]{1,32}$/u;

// A bare name normalized, or undefined when it isn't one. Normalizing first lets a decomposed
// letter (`и` + combining breve) count as the one letter it composes to.
export function toTagName(text: string): TagName | undefined {
  const name = text.normalize('NFC').toLowerCase();
  return TAG_NAME.test(name) ? (name as TagName) : undefined;
}

// A whole word `#name` as a tag; undefined for any other word, `#` alone included.
export function tagOfWord(word: string): TagName | undefined {
  return word.startsWith('#') ? toTagName(word.slice(1)) : undefined;
}

// First-seen order, each name once.
export function uniqueTags(tags: Iterable<TagName>): TagName[] {
  return [...new Set(tags)];
}

// The `expenses.tags` column: the names space-joined, NULL for none.
export function encodeTags(tags: readonly TagName[]): string | null {
  return tags.length === 0 ? null : tags.join(' ');
}

export function decodeTags(stored: string | null): TagName[] {
  if (stored === null) return [];
  return stored.split(' ').flatMap((word) => toTagName(word) ?? []);
}

export interface TaggedMoney extends DatedMoney {
  readonly tags: readonly TagName[];
  readonly occurredAt: Date;
}

export interface TagTotal {
  readonly name: TagName;
  // Everything with a rate, in the ledger's currency; undefined when nothing converts.
  readonly converted: Money | undefined;
  // Per currency, what had no rate, alphabetically, never added to `converted`.
  readonly unconverted: readonly Money[];
  // The latest occurred_on among its expenses.
  readonly lastOn: LocalDate;
}

// Each tag of `items` with its total converted into `target` at each expense's day rate
// (ADR-0022), most recently used first: by the latest occurred_on, then occurred_at, then name.
// An expense with two tags counts fully under each.
export function summarizeTags(
  items: Iterable<TaggedMoney>,
  target: CurrencyCode,
  rateOf: RateOf,
): TagTotal[] {
  const byTag = groupByTag(items);
  return [...byTag]
    .map(([name, expenses]) => {
      const { converted, unconverted } = summarizeConverted(expenses, target, rateOf);
      const latest = expenses.reduce((a, b) => (laterThan(b, a) ? b : a));
      return {
        total: {
          name,
          converted:
            converted === undefined
              ? undefined
              : { amountMinor: converted.totalMinor, currency: converted.currency },
          unconverted: unconverted.map((c) => ({
            amountMinor: c.totalMinor,
            currency: c.currency,
          })),
          lastOn: latest.occurredOn,
        },
        latest,
      };
    })
    .sort((a, b) =>
      laterThan(a.latest, b.latest)
        ? -1
        : laterThan(b.latest, a.latest)
          ? 1
          : a.total.name < b.total.name
            ? -1
            : 1,
    )
    .map(({ total }) => total);
}

function groupByTag<T extends TaggedMoney>(items: Iterable<T>): Map<TagName, T[]> {
  const byTag = new Map<TagName, T[]>();
  for (const item of items) {
    for (const tag of item.tags) {
      const list = byTag.get(tag) ?? [];
      byTag.set(tag, list);
      list.push(item);
    }
  }
  return byTag;
}

function laterThan(a: TaggedMoney, b: TaggedMoney): boolean {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn > b.occurredOn;
  return a.occurredAt.getTime() > b.occurredAt.getTime();
}
