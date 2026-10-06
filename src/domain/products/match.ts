import { CATALOG, type CatalogProduct } from './catalog.js';

// The catalog product a normalized item name names (ADR-0039). Of the products whose keyword
// occurs in the name and whose exclusions don't, the one whose keyword starts earliest wins, and
// a tie goes to catalog order: `beli luk` is garlic, though `luk` alone is onion.

function words(nameKey: string): string[] {
  return nameKey.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
}

function wordMatches(pattern: string, word: string): boolean {
  return pattern.endsWith('*') ? word.startsWith(pattern.slice(0, -1)) : word === pattern;
}

// The index of the first word where `phrase` occurs, or -1.
function phraseAt(phrase: string, nameWords: readonly string[]): number {
  const parts = phrase.split(' ');
  for (let start = 0; start + parts.length <= nameWords.length; start++) {
    if (parts.every((part, i) => wordMatches(part, nameWords[start + i] ?? ''))) return start;
  }
  return -1;
}

export function matchProduct(nameKey: string): CatalogProduct | undefined {
  const nameWords = words(nameKey);
  let best: { product: CatalogProduct; at: number } | undefined;
  for (const product of CATALOG) {
    if ((product.exclude ?? []).some((phrase) => phraseAt(phrase, nameWords) >= 0)) continue;
    for (const keyword of product.keywords) {
      const at = phraseAt(keyword, nameWords);
      if (at >= 0 && (best === undefined || at < best.at)) best = { product, at };
    }
  }
  return best?.product;
}
