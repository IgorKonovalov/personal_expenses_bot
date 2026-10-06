import { toCurrencyCode, type CurrencyCode } from './currencies.js';
import { parseAmount, type Money } from './money.js';

// Personal debts (ADR-0030): signed operations against a named person, balanced per person and
// currency. Nothing here converts between currencies or nets one against another.

export type DebtKind = 'lend' | 'borrow' | 'repaid_to_me' | 'i_repaid';

// Which way money moved first: lent out, or borrowed in.
export type DebtDirection = 'lend' | 'borrow';

export interface DebtOpAmount<P> {
  readonly personId: P;
  readonly kind: DebtKind;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

// What the operation adds to the person's balance. Positive means they owe me.
export function signedAmount(kind: DebtKind, amountMinor: number): number {
  return kind === 'lend' || kind === 'i_repaid' ? amountMinor : -amountMinor;
}

export interface DebtBalance<P> extends Money {
  readonly personId: P;
}

// Every non-zero (person, currency) balance of the operations, in first-seen order.
export function debtBalances<P>(ops: readonly DebtOpAmount<P>[]): DebtBalance<P>[] {
  const sums = new Map<P, Map<CurrencyCode, number>>();
  for (const op of ops) {
    const byCurrency = sums.get(op.personId) ?? new Map<CurrencyCode, number>();
    byCurrency.set(
      op.currency,
      (byCurrency.get(op.currency) ?? 0) + signedAmount(op.kind, op.amountMinor),
    );
    sums.set(op.personId, byCurrency);
  }
  const balances: DebtBalance<P>[] = [];
  for (const [personId, byCurrency] of sums) {
    for (const [currency, amountMinor] of byCurrency) {
      if (amountMinor !== 0) balances.push({ personId, currency, amountMinor });
    }
  }
  return balances;
}

// A bill of `amountMinor` split `parts` ways: each other person owes `each`, and the payer's own
// share absorbs the remainder, so share + (parts - 1) * each is the whole.
export function splitShares(
  amountMinor: number,
  parts: number,
): { readonly share: number; readonly each: number } {
  const each = Math.floor(amountMinor / parts);
  return { share: amountMinor - (parts - 1) * each, each };
}

// A repayment of a balance: they repay me what they owe (positive), I repay what I owe
// (negative).
export function repaymentKind(balanceMinor: number): 'repaid_to_me' | 'i_repaid' {
  return balanceMinor > 0 ? 'repaid_to_me' : 'i_repaid';
}

export type RepaymentCheck =
  { readonly kind: 'ok' } | { readonly kind: 'wrongCurrency' | 'tooMuch' | 'settled' };

// A repayment closes in the debt's own currency (ADR-0030) and never past zero.
export function checkRepayment(balance: Money, repayment: Money): RepaymentCheck {
  if (balance.amountMinor === 0) return { kind: 'settled' };
  if (repayment.currency !== balance.currency) return { kind: 'wrongCurrency' };
  if (repayment.amountMinor > Math.abs(balance.amountMinor)) return { kind: 'tooMuch' };
  return { kind: 'ok' };
}

// The /debts order: people who owe me first, then people I owe; each group by name, then by
// currency.
export function sortDebtLines<L extends Money & { readonly name: string }>(
  lines: readonly L[],
): L[] {
  return [...lines].sort(
    (a, b) =>
      Number(a.amountMinor < 0) - Number(b.amountMinor < 0) ||
      a.name.localeCompare(b.name, 'ru') ||
      a.currency.localeCompare(b.currency),
  );
}

// The longest person name, in characters, after trimming.
export const MAX_PERSON_NAME = 40;

export type PersonNameResult =
  | { readonly kind: 'valid'; readonly name: string; readonly key: string }
  | { readonly kind: 'invalid'; readonly reason: 'empty' | 'tooLong' };

// A typed person name: 1-40 characters after trimming, inner whitespace collapsed. `key` is what
// a name is matched on, so «петя» finds «Петя».
export function parsePersonName(text: string): PersonNameResult {
  const name = text.trim().replace(/\s+/g, ' ');
  if (name === '') return { kind: 'invalid', reason: 'empty' };
  if (Array.from(name).length > MAX_PERSON_NAME) return { kind: 'invalid', reason: 'tooLong' };
  return { kind: 'valid', name, key: personNameKey(name) };
}

export function personNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

export type DebtAmountResult =
  | { readonly kind: 'ok'; readonly amountMinor: number; readonly currency: CurrencyCode }
  | { readonly kind: 'invalid' };

// `<amount> [CUR]`, read by the ADR-0004 parser; without a code, `currency`. An amount that
// reads two ways (`1.200`) is refused rather than asked about.
export function parseDebtAmount(text: string, currency: CurrencyCode): DebtAmountResult {
  const trimmed = text.trim();
  const coded = /^(.*\S)\s+([A-Za-z]{3})$/.exec(trimmed);
  const named = coded?.[2] === undefined ? undefined : toCurrencyCode(coded[2]);
  const chosen = named ?? currency;
  const token = named === undefined ? trimmed : (coded?.[1] ?? '');
  const amount = parseAmount(token, chosen);
  return amount.kind === 'ok'
    ? { kind: 'ok', amountMinor: amount.amountMinor, currency: chosen }
    : { kind: 'invalid' };
}
