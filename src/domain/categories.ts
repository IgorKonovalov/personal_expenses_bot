import { CATEGORY_PRESETS, FALLBACK_PRESET, type PresetKey } from './categoryPresets.js';
import type { CurrencyCode } from './currencies.js';
import { parseExpenseText } from './expenseText.js';

// Russian lowercase, `ё` -> `е`, trimmed, inner whitespace collapsed. SQLite's NOCASE folds ASCII
// only, so the folding happens here and the key is stored beside the text (ADR-0007, ADR-0008).
function fold(text: string): string {
  return text
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ');
}

// The key an expense's description is learned under (ADR-0008).
export function descriptionKey(description: string): string {
  return fold(description);
}

// The key category names are unique by within a ledger (ADR-0007).
export function categoryNameKey(name: string): string {
  return fold(name);
}

export const MAX_CATEGORY_NAME = 32;

export type CategoryNameResult =
  | { readonly kind: 'ok'; readonly name: string; readonly nameKey: string }
  | { readonly kind: 'empty' }
  // Parses as an amount and a description: an expense typed into the prompt (ADR-0009).
  | { readonly kind: 'expenseShaped' }
  // `450` alone, or any name the expense parser could read as an amount.
  | { readonly kind: 'startsWithDigit' }
  | { readonly kind: 'tooLong' };

// A typed category name, trimmed. Uniqueness against the ledger is the service's check.
export function parseCategoryName(text: string, currency: CurrencyCode): CategoryNameResult {
  const name = text.trim();
  if (name === '') return { kind: 'empty' };
  const asExpense = parseExpenseText(name, currency).kind;
  if (asExpense === 'expense' || asExpense === 'ambiguous') return { kind: 'expenseShaped' };
  if (/^\d/.test(name)) return { kind: 'startsWithDigit' };
  if (Array.from(name).length > MAX_CATEGORY_NAME) return { kind: 'tooLong' };
  return { kind: 'ok', name, nameKey: categoryNameKey(name) };
}

export interface SuggestableCategory {
  readonly id: number;
  readonly presetKey: string | null;
}

export interface SuggestInput<C extends SuggestableCategory> {
  readonly description: string;
  // The ledger's active categories. Archived ones are never suggested.
  readonly categories: readonly C[];
  // The category of the ledger's most recent live expense with the same description key.
  readonly historyCategoryId?: number | undefined;
}

// ADR-0008: history, then the first description word that starts with a preset keyword, then
// the ledger's `other` category.
export function suggestCategory<C extends SuggestableCategory>(input: SuggestInput<C>): C {
  const { categories } = input;
  const fromHistory = categories.find((c) => c.id === input.historyCategoryId);
  if (fromHistory !== undefined) return fromHistory;

  const byPreset = (key: PresetKey) => categories.find((c) => c.presetKey === key);
  for (const word of descriptionKey(input.description).split(' ')) {
    const preset = CATEGORY_PRESETS.find((p) => p.keywords.some((k) => word.startsWith(k)));
    const category = preset === undefined ? undefined : byPreset(preset.key);
    if (category !== undefined) return category;
  }

  const fallback = byPreset(FALLBACK_PRESET);
  if (fallback === undefined) throw new Error('ledger has no fallback category');
  return fallback;
}
