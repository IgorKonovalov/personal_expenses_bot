// The built-in products (ADR-0039): generic groceries a receipt item maps to by keyword. A
// keyword is matched against the words of a normalized name (normalize.ts): a bare word matches
// that word exactly, `word*` any word starting with it, and several words a run of consecutive
// words. An exclusion uses the same syntax and keeps the product off a name that has it.
// A key is at most 24 ASCII characters: it travels in callback data as `b:<key>`.

export interface CatalogProduct {
  readonly key: string;
  readonly name: string;
  readonly keywords: readonly string[];
  readonly exclude?: readonly string[];
}

export const CATALOG: readonly CatalogProduct[] = [
  {
    key: 'milk',
    name: 'Молоко',
    keywords: ['mleko', 'mlijeko'],
    exclude: ['cokolad*', 'kakao', 'kisel*', 'kokos*', 'ovsen*', 'bademov*', 'sojin*', 'prahu'],
  },
  { key: 'yogurt', name: 'Йогурт', keywords: ['jogurt*'] },
  { key: 'kefir', name: 'Кефир', keywords: ['kefir'] },
  { key: 'sour_cream', name: 'Сметана', keywords: ['pavlak*'] },
  { key: 'cheese', name: 'Сыр', keywords: ['sir', 'kackavalj', 'gauda', 'edamer'] },
  { key: 'butter', name: 'Сливочное масло', keywords: ['puter', 'maslac'] },
  { key: 'eggs', name: 'Яйца', keywords: ['jaja', 'jaje'] },
  { key: 'bread', name: 'Хлеб', keywords: ['hleb', 'hljeb', 'vekna'], exclude: ['mrvic*'] },
  { key: 'flour', name: 'Мука', keywords: ['brasno'] },
  { key: 'sugar', name: 'Сахар', keywords: ['secer'] },
  { key: 'rice', name: 'Рис', keywords: ['pirinac', 'riza'] },
  { key: 'pasta', name: 'Макароны', keywords: ['testenin*', 'spaget*', 'makaron*', 'penne'] },
  { key: 'oil', name: 'Растительное масло', keywords: ['ulje'] },
  { key: 'coffee', name: 'Кофе', keywords: ['kafa'] },
  { key: 'tea', name: 'Чай', keywords: ['caj'] },
  { key: 'chicken', name: 'Курица', keywords: ['pilec*', 'piletin*', 'pile'] },
  { key: 'pork', name: 'Свинина', keywords: ['svinj*'] },
  { key: 'beef', name: 'Говядина', keywords: ['junet*', 'govedj*'] },
  { key: 'mince', name: 'Фарш', keywords: ['mleveno meso', 'mleveno'] },
  { key: 'ham', name: 'Ветчина', keywords: ['sunka'] },
  { key: 'sausages', name: 'Сосиски и колбаса', keywords: ['virsl*', 'kobasic*'] },
  { key: 'potatoes', name: 'Картофель', keywords: ['krompir'] },
  { key: 'garlic', name: 'Чеснок', keywords: ['beli luk', 'bijeli luk'] },
  { key: 'onion', name: 'Лук', keywords: ['luk'] },
  {
    key: 'tomatoes',
    name: 'Помидоры',
    keywords: ['paradajz'],
    exclude: ['sos', 'pire', 'pelat*', 'kecap', 'sok'],
  },
  { key: 'cucumbers', name: 'Огурцы', keywords: ['krastavac', 'krastavc*'], exclude: ['kisel*'] },
  { key: 'peppers', name: 'Перец', keywords: ['paprika'], exclude: ['aleva', 'mleven*'] },
  { key: 'carrots', name: 'Морковь', keywords: ['sargarep*'] },
  { key: 'cabbage', name: 'Капуста', keywords: ['kupus'] },
  { key: 'bananas', name: 'Бананы', keywords: ['banana', 'banane'] },
  { key: 'apples', name: 'Яблоки', keywords: ['jabuk*'], exclude: ['sok', 'sirce'] },
  { key: 'oranges', name: 'Апельсины', keywords: ['pomorandz*'], exclude: ['sok'] },
  { key: 'lemons', name: 'Лимоны', keywords: ['limun'], exclude: ['sok'] },
  { key: 'water', name: 'Вода', keywords: ['voda'], exclude: ['toaletn*'] },
  { key: 'juice', name: 'Сок', keywords: ['sok'] },
  { key: 'beer', name: 'Пиво', keywords: ['pivo'] },
  { key: 'wine', name: 'Вино', keywords: ['vino'] },
  { key: 'toilet_paper', name: 'Туалетная бумага', keywords: ['toalet papir', 'toaletni papir'] },
];

const BY_KEY = new Map(CATALOG.map((product) => [product.key, product]));

export function catalogProduct(key: string): CatalogProduct | undefined {
  return BY_KEY.get(key);
}
