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
  },
  {
    key: 'transport',
    name: 'Транспорт',
    keywords: ['такси', 'автобус', 'метро', 'бензин', 'парковк', 'проезд', 'taxi', 'bus', 'fuel'],
  },
  {
    key: 'housing',
    name: 'Жильё и коммуналка',
    keywords: ['аренд', 'квартир', 'коммунал', 'электричеств', 'rent'],
  },
  {
    key: 'health',
    name: 'Здоровье',
    keywords: ['аптек', 'лекарств', 'врач', 'стоматолог', 'анализ', 'pharmacy'],
  },
  {
    key: 'clothes',
    name: 'Одежда и обувь',
    keywords: ['одежд', 'обув', 'куртк', 'джинс', 'clothes', 'shoes'],
  },
  {
    key: 'fun',
    name: 'Развлечения',
    keywords: ['кино', 'театр', 'концерт', 'музей', 'cinema', 'movie'],
  },
  {
    key: 'telecom',
    name: 'Связь и интернет',
    keywords: ['телефон', 'интернет', 'мобильн', 'связь', 'phone', 'internet'],
  },
  {
    key: 'gifts',
    name: 'Подарки',
    keywords: ['подар', 'цветы', 'gift'],
  },
  { key: 'other', name: 'Другое', keywords: [] },
];
