import { describe, expect, it } from 'vitest';
import { categoryNameKey, descriptionKey, suggestCategory } from './categories.js';
import { CATEGORY_PRESETS } from './categoryPresets.js';

// A freshly seeded ledger: one active category per preset, ids in preset order.
const seeded = CATEGORY_PRESETS.map((preset, i) => ({ id: i + 1, presetKey: preset.key }));

function presetOf(id: number): string | null | undefined {
  return seeded.find((c) => c.id === id)?.presetKey;
}

describe('descriptionKey', () => {
  it('lowercases, trims and collapses inner whitespace', () => {
    expect(descriptionKey('  Кофе   Латте ')).toBe('кофе латте');
  });

  it('folds ё into е', () => {
    expect(descriptionKey('Ёлка')).toBe('елка');
  });
});

describe('categoryNameKey', () => {
  it('uses the same folding', () => {
    expect(categoryNameKey('  Кафе   и РЕСТОРАНЫ ')).toBe('кафе и рестораны');
    expect(categoryNameKey('Жильё')).toBe('жилье');
  });
});

describe('suggestCategory by keyword on a freshly seeded ledger', () => {
  it.each([
    ['кофе', 'cafe'],
    ['Кофейня', 'cafe'],
    ['такси до дома', 'transport'],
    ['что-то', 'other'],
    ['coffee', 'cafe'],
  ])('%j -> %s', (description, preset) => {
    expect(presetOf(suggestCategory({ description, categories: seeded }).id)).toBe(preset);
  });

  it('falls through to other when the matching category is not active', () => {
    const withoutCafe = seeded.filter((c) => c.presetKey !== 'cafe');

    expect(suggestCategory({ description: 'кофе', categories: withoutCafe }).presetKey).toBe(
      'other',
    );
  });

  it('prefers an active history category over the keyword rule', () => {
    const groceries = seeded.find((c) => c.presetKey === 'groceries');

    expect(
      suggestCategory({
        description: 'кофе',
        categories: seeded,
        historyCategoryId: groceries?.id,
      }),
    ).toBe(groceries);
  });

  it('ignores a history category that is not among the active ones', () => {
    expect(
      suggestCategory({ description: 'кофе', categories: seeded, historyCategoryId: 999 })
        .presetKey,
    ).toBe('cafe');
  });

  it('throws when the ledger has no other category', () => {
    expect(() => suggestCategory({ description: 'что-то', categories: [] })).toThrow(/fallback/);
  });
});
