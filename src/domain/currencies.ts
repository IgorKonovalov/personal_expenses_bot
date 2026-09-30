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
