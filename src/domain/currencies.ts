// ISO-4217 codes the bot understands, with their minor-unit exponent (digits after the decimal
// point). Every exponent in the codebase comes from this table.
const EXPONENTS = {
  AMD: 2,
  BAM: 2,
  BYN: 2,
  CHF: 2,
  CNY: 2,
  CZK: 2,
  EUR: 2,
  GBP: 2,
  GEL: 2,
  HUF: 2,
  JPY: 0,
  KZT: 2,
  PLN: 2,
  RSD: 2,
  RUB: 2,
  TRY: 2,
  UAH: 2,
  USD: 2,
  UZS: 2,
} as const satisfies Record<string, number>;

export type CurrencyCode = keyof typeof EXPONENTS;

// Every code in the table, in table order.
export const CURRENCY_CODES = Object.keys(EXPONENTS) as readonly CurrencyCode[];

// Case-insensitive lookup: `eur` -> `EUR`. Returns undefined for codes not in the table.
export function toCurrencyCode(raw: string): CurrencyCode | undefined {
  const code = raw.toUpperCase();
  return Object.hasOwn(EXPONENTS, code) ? (code as CurrencyCode) : undefined;
}

export function currencyExponent(currency: CurrencyCode): number {
  return EXPONENTS[currency];
}

// Where an alias may stand (ADR-0046). `word`: a separate word after the amount (`300 евро`).
// `glued`: touching the amount, after it or before it (`300€`, `€300`, `2500р`). `both`: either.
export type AliasPlacement = 'word' | 'glued' | 'both';

// Lower-cased alias -> ISO code.
export const CURRENCY_ALIASES: ReadonlyArray<{
  readonly alias: string;
  readonly code: CurrencyCode;
  readonly placement: AliasPlacement;
}> = [
  { alias: '€', code: 'EUR', placement: 'both' },
  { alias: 'евро', code: 'EUR', placement: 'word' },
  { alias: '$', code: 'USD', placement: 'both' },
  { alias: 'долл', code: 'USD', placement: 'word' },
  { alias: 'доллар', code: 'USD', placement: 'word' },
  { alias: 'доллара', code: 'USD', placement: 'word' },
  { alias: 'долларов', code: 'USD', placement: 'word' },
  { alias: '£', code: 'GBP', placement: 'both' },
  { alias: '¥', code: 'JPY', placement: 'both' },
  { alias: '₽', code: 'RUB', placement: 'both' },
  // A separate `р` stays description: `500 р кофе` is 500 «р кофе».
  { alias: 'р', code: 'RUB', placement: 'glued' },
  { alias: 'р.', code: 'RUB', placement: 'glued' },
  { alias: 'руб', code: 'RUB', placement: 'both' },
  { alias: 'руб.', code: 'RUB', placement: 'both' },
  { alias: 'рубль', code: 'RUB', placement: 'word' },
  { alias: 'рубля', code: 'RUB', placement: 'word' },
  { alias: 'рублей', code: 'RUB', placement: 'word' },
  { alias: 'дин', code: 'RSD', placement: 'both' },
  { alias: 'дин.', code: 'RSD', placement: 'both' },
  { alias: 'динар', code: 'RSD', placement: 'word' },
  { alias: 'динара', code: 'RSD', placement: 'word' },
  { alias: 'динаров', code: 'RSD', placement: 'word' },
  { alias: 'din', code: 'RSD', placement: 'both' },
  { alias: 'din.', code: 'RSD', placement: 'both' },
  { alias: 'dinara', code: 'RSD', placement: 'word' },
  { alias: '₴', code: 'UAH', placement: 'both' },
  { alias: 'грн', code: 'UAH', placement: 'both' },
  { alias: '₸', code: 'KZT', placement: 'both' },
  { alias: 'тенге', code: 'KZT', placement: 'word' },
  { alias: '₺', code: 'TRY', placement: 'both' },
  { alias: '₾', code: 'GEL', placement: 'both' },
  { alias: 'лари', code: 'GEL', placement: 'word' },
];

// The aliases that may touch the amount, longest first, so `руб.` wins over `руб` and `р`.
export const GLUED_ALIASES = CURRENCY_ALIASES.filter(({ placement }) => placement !== 'word')
  .map(({ alias, code }) => ({ alias, code }))
  .toSorted((a, b) => b.alias.length - a.alias.length);

// The currency a word names. As a separate word (`word`), an ISO code in any case or a
// `word`/`both` alias; glued to the amount (`glued`), a `glued`/`both` alias only.
export function currencyOfWord(
  word: string,
  placement: 'word' | 'glued' = 'word',
): CurrencyCode | undefined {
  const lower = word.toLowerCase();
  const alias = CURRENCY_ALIASES.find(
    (entry) =>
      entry.alias === lower && (entry.placement === 'both' || entry.placement === placement),
  );
  if (alias !== undefined) return alias.code;
  return placement === 'word' && /^[A-Za-z]{3}$/.test(word) ? toCurrencyCode(word) : undefined;
}
