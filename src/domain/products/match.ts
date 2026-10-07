import { CATALOG, type CatalogProduct } from './catalog.js';
import { normalize } from './normalize.js';

// The catalog product a normalized item name names (ADR-0039). Of the products whose keyword
// occurs in the name and whose exclusions don't, the one whose keyword starts earliest wins, and
// a tie goes to catalog order: `beli luk` is garlic, though `luk` alone is onion.

function words(nameKey: string): string[] {
  return nameKey.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
}

// One word of a keyword or exclusion: `word*` matches any word starting with `text`.
interface Pattern {
  readonly text: string;
  readonly prefix: boolean;
}

type Phrase = readonly Pattern[];

function compile(phrase: string): Phrase {
  return phrase
    .split(' ')
    .map((part) =>
      part.endsWith('*')
        ? { text: part.slice(0, -1), prefix: true }
        : { text: part, prefix: false },
    );
}

// The catalog with every keyword and exclusion split into words once, at module load.
const COMPILED = CATALOG.map((product) => ({
  product,
  keywords: product.keywords.map(compile),
  exclude: (product.exclude ?? []).map(compile),
}));

function wordMatches(pattern: Pattern, word: string): boolean {
  return pattern.prefix ? word.startsWith(pattern.text) : word === pattern.text;
}

// The index of the first word where `phrase` occurs, or -1.
function phraseAt(phrase: Phrase, nameWords: readonly string[]): number {
  for (let start = 0; start + phrase.length <= nameWords.length; start++) {
    if (phrase.every((part, i) => wordMatches(part, nameWords[start + i] ?? ''))) return start;
  }
  return -1;
}

export function matchProduct(nameKey: string): CatalogProduct | undefined {
  const nameWords = words(nameKey);
  let best: { product: CatalogProduct; at: number } | undefined;
  for (const { product, keywords, exclude } of COMPILED) {
    if (exclude.some((phrase) => phraseAt(phrase, nameWords) >= 0)) continue;
    for (const keyword of keywords) {
      const at = phraseAt(keyword, nameWords);
      if (at >= 0 && (best === undefined || at < best.at)) best = { product, at };
    }
  }
  return best?.product;
}

export interface NameMatch {
  readonly nameKey: string;
  // The catalog's product, before any user answer.
  readonly ruleRef: `b:${string}` | undefined;
}

export interface NameMatcher {
  match(raw: string): NameMatch;
  readonly size: number;
}

// A memo from a raw item name to its normalized key and rule product (ADR-0041). It holds at
// most `capacity` names: an insert past it evicts the oldest-inserted one. A hit does not
// refresh an entry's age.
export function createNameMatcher(
  capacity: number,
  match: (nameKey: string) => CatalogProduct | undefined = matchProduct,
): NameMatcher {
  const memo = new Map<string, NameMatch>();
  return {
    match(raw) {
      const seen = memo.get(raw);
      if (seen !== undefined) return seen;
      const nameKey = normalize(raw);
      const product = match(nameKey);
      const answer: NameMatch = {
        nameKey,
        ruleRef: product === undefined ? undefined : `b:${product.key}`,
      };
      if (memo.size >= capacity) {
        const oldest = memo.keys().next();
        if (oldest.done !== true) memo.delete(oldest.value);
      }
      memo.set(raw, answer);
      return answer;
    },
    get size() {
      return memo.size;
    },
  };
}
