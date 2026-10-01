// The categories every new ledger starts with (ADR-0007), and the keyword rules that target them
// by `key` (ADR-0008). A rename keeps the key, so it keeps its rules. The names are seed data that
// becomes user-editable rows, not copy, so they live here rather than in the messages module.
// Keywords are matched as prefixes of the description's words after `descriptionKey` folding, so
// they are written lowercase, with `е` for `ё`.

export type PresetKey =
  | 'groceries'
  | 'cafe'
  | 'transport'
  | 'housing'
  | 'health'
  | 'clothes'
  | 'fun'
  | 'telecom'
  | 'gifts'
  | 'other';

export interface CategoryPreset {
  readonly key: PresetKey;
  readonly name: string;
  readonly keywords: readonly string[];
  // Fixed costs a budget scoped to optional spending leaves out (ADR-0017). Migration 0009 marks
  // existing preset rows with the same set.
  readonly essential: boolean;
}

// The fallback when nothing else matches. It can't be archived.
export const FALLBACK_PRESET: PresetKey = 'other';

export const CATEGORY_PRESETS: readonly CategoryPreset[] = [
  {
    key: 'groceries',
    name: 'Продукты',
    keywords: [
      'продукт',
      'магазин',
      'супермаркет',
      'хлеб',
      'молок',
      'овощ',
      'фрукт',
      'лидл',
      'макси',
    ],
    essential: true,
  },
  {
    key: 'cafe',
    name: 'Кафе и рестораны',
    keywords: [
      'кофе',
      'кафе',
      'ресторан',
      'обед',
      'ужин',
      'завтрак',
      'пицц',
      'coffee',
      'cafe',
      'restaurant',
      'lunch',
      'dinner',
    ],
    essential: false,
  },
  {
    key: 'transport',
    name: 'Транспорт',
    keywords: ['такси', 'автобус', 'метро', 'бензин', 'парковк', 'проезд', 'taxi', 'bus', 'fuel'],
    essential: true,
  },
  {
    key: 'housing',
    name: 'Жильё и коммуналка',
    keywords: ['аренд', 'квартир', 'коммунал', 'электричеств', 'rent'],
    essential: true,
  },
  {
    key: 'health',
    name: 'Здоровье',
    keywords: ['аптек', 'лекарств', 'врач', 'стоматолог', 'анализ', 'pharmacy'],
    essential: true,
  },
  {
    key: 'clothes',
    name: 'Одежда и обувь',
    keywords: ['одежд', 'обув', 'куртк', 'джинс', 'clothes', 'shoes'],
    essential: false,
  },
  {
    key: 'fun',
    name: 'Развлечения',
    keywords: ['кино', 'театр', 'концерт', 'музей', 'cinema', 'movie'],
    essential: false,
  },
  {
    key: 'telecom',
    name: 'Связь и интернет',
    keywords: ['телефон', 'интернет', 'мобильн', 'связь', 'phone', 'internet'],
    essential: true,
  },
  {
    key: 'gifts',
    name: 'Подарки',
    keywords: ['подар', 'цветы', 'gift'],
    essential: false,
  },
  { key: 'other', name: 'Другое', keywords: [], essential: false },
];
