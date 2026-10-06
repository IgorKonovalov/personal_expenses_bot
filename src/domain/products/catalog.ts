import type { Unit } from './amount.js';

// The built-in products (ADR-0039): generic groceries a receipt item maps to by keyword. A
// keyword is matched against the words of a normalized name (normalize.ts): a bare word matches
// that word exactly, `word*` any word starting with it, and several words a run of consecutive
// words. An exclusion uses the same syntax and keeps the product off a name that has it.
// A key is at most 24 ASCII characters: it travels in callback data as `b:<key>`. The unit is
// what a price is quoted per: a litre, a kilogram or a piece.

export interface CatalogProduct {
  readonly key: string;
  readonly name: string;
  readonly unit: Unit;
  readonly keywords: readonly string[];
  readonly exclude?: readonly string[];
}

export const CATALOG: readonly CatalogProduct[] = [
  {
    key: 'milk',
    name: 'Молоко',
    unit: 'l',
    keywords: ['mleko', 'mlijeko'],
    exclude: ['cokolad*', 'kakao', 'kisel*', 'kokos*', 'ovsen*', 'bademov*', 'sojin*', 'prahu'],
  },
  { key: 'yogurt', name: 'Йогурт', unit: 'l', keywords: ['jogurt*'] },
  { key: 'kefir', name: 'Кефир', unit: 'l', keywords: ['kefir'] },
  { key: 'sour_cream', name: 'Сметана', unit: 'kg', keywords: ['pavlak*'] },
  { key: 'cheese', name: 'Сыр', unit: 'kg', keywords: ['sir', 'kackavalj', 'gauda', 'edamer'] },
  { key: 'butter', name: 'Сливочное масло', unit: 'kg', keywords: ['puter', 'maslac'] },
  { key: 'eggs', name: 'Яйца', unit: 'pcs', keywords: ['jaja', 'jaje'] },
  {
    key: 'bread',
    name: 'Хлеб',
    unit: 'kg',
    keywords: ['hleb', 'hljeb', 'vekna'],
    exclude: ['mrvic*'],
  },
  { key: 'flour', name: 'Мука', unit: 'kg', keywords: ['brasno'] },
  { key: 'sugar', name: 'Сахар', unit: 'kg', keywords: ['secer'] },
  { key: 'rice', name: 'Рис', unit: 'kg', keywords: ['pirinac', 'riza'] },
  {
    key: 'pasta',
    name: 'Макароны',
    unit: 'kg',
    keywords: ['testenin*', 'spaget*', 'makaron*', 'penne'],
  },
  { key: 'oil', name: 'Растительное масло', unit: 'l', keywords: ['ulje'] },
  { key: 'coffee', name: 'Кофе', unit: 'kg', keywords: ['kafa'] },
  { key: 'tea', name: 'Чай', unit: 'pcs', keywords: ['caj'] },
  { key: 'chicken', name: 'Курица', unit: 'kg', keywords: ['pilec*', 'piletin*', 'pile'] },
  { key: 'pork', name: 'Свинина', unit: 'kg', keywords: ['svinj*'] },
  { key: 'beef', name: 'Говядина', unit: 'kg', keywords: ['junet*', 'govedj*'] },
  { key: 'mince', name: 'Фарш', unit: 'kg', keywords: ['mleveno meso', 'mleveno'] },
  { key: 'ham', name: 'Ветчина', unit: 'kg', keywords: ['sunka'] },
  { key: 'sausages', name: 'Сосиски и колбаса', unit: 'kg', keywords: ['virsl*', 'kobasic*'] },
  { key: 'potatoes', name: 'Картофель', unit: 'kg', keywords: ['krompir'] },
  { key: 'garlic', name: 'Чеснок', unit: 'kg', keywords: ['beli luk', 'bijeli luk'] },
  { key: 'onion', name: 'Лук', unit: 'kg', keywords: ['luk'] },
  {
    key: 'tomatoes',
    name: 'Помидоры',
    unit: 'kg',
    keywords: ['paradajz'],
    exclude: ['sos', 'pire', 'pelat*', 'kecap', 'sok'],
  },
  {
    key: 'cucumbers',
    name: 'Огурцы',
    unit: 'kg',
    keywords: ['krastavac', 'krastavc*'],
    exclude: ['kisel*'],
  },
  {
    key: 'peppers',
    name: 'Перец',
    unit: 'kg',
    keywords: ['paprika'],
    exclude: ['aleva', 'mleven*'],
  },
  { key: 'carrots', name: 'Морковь', unit: 'kg', keywords: ['sargarep*'] },
  { key: 'cabbage', name: 'Капуста', unit: 'kg', keywords: ['kupus'] },
  { key: 'bananas', name: 'Бананы', unit: 'kg', keywords: ['banana', 'banane'] },
  { key: 'apples', name: 'Яблоки', unit: 'kg', keywords: ['jabuk*'], exclude: ['sok', 'sirce'] },
  { key: 'oranges', name: 'Апельсины', unit: 'kg', keywords: ['pomorandz*'], exclude: ['sok'] },
  { key: 'lemons', name: 'Лимоны', unit: 'kg', keywords: ['limun'], exclude: ['sok'] },
  { key: 'water', name: 'Вода', unit: 'l', keywords: ['voda'], exclude: ['toaletn*'] },
  { key: 'juice', name: 'Сок', unit: 'l', keywords: ['sok'] },
  { key: 'beer', name: 'Пиво', unit: 'l', keywords: ['pivo'] },
  { key: 'wine', name: 'Вино', unit: 'l', keywords: ['vino'] },
  {
    key: 'toilet_paper',
    name: 'Туалетная бумага',
    unit: 'pcs',
    keywords: ['toalet papir', 'toaletni papir'],
  },
];

const BY_KEY = new Map(CATALOG.map((product) => [product.key, product]));

export function catalogProduct(key: string): CatalogProduct | undefined {
  return BY_KEY.get(key);
}
