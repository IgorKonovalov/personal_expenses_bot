import { createHash } from 'node:crypto';
import type { CurrencyCode } from './currencies.js';
import type { LocalDate } from './time.js';

// Group settle-up (ADR-0030): each expense is split equally among the members who had joined by
// its local date, the payer absorbing the remainder; recorded transfers move balances back.
// Everything is per currency: nothing is converted or netted across currencies.

export interface SettleMember<U> {
  readonly id: U;
  // The local date (in the ledger's zone) the membership began.
  readonly joinedOn: LocalDate;
}

export interface SettleExpense<U> {
  readonly paidBy: U;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly occurredOn: LocalDate;
}

export interface SettleTransfer<U> {
  readonly from: U;
  readonly to: U;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

// Each currency's balance per member, in member order. Positive: the member is owed.
export type SettleBalances<U> = Map<CurrencyCode, Map<U, number>>;

export function settleBalances<U>(
  members: readonly SettleMember<U>[],
  expenses: readonly SettleExpense<U>[],
  transfers: readonly SettleTransfer<U>[],
): SettleBalances<U> {
  const balances: SettleBalances<U> = new Map();
  const add = (currency: CurrencyCode, id: U, amount: number) => {
    const byMember = balances.get(currency) ?? new Map(members.map((m) => [m.id, 0]));
    byMember.set(id, (byMember.get(id) ?? 0) + amount);
    balances.set(currency, byMember);
  };
  for (const expense of expenses) {
    const others = members.filter(
      (m) => m.id !== expense.paidBy && m.joinedOn <= expense.occurredOn,
    );
    const each = Math.floor(expense.amountMinor / (others.length + 1));
    for (const member of others) {
      add(expense.currency, member.id, -each);
      add(expense.currency, expense.paidBy, each);
    }
    if (others.length === 0) add(expense.currency, expense.paidBy, 0);
  }
  for (const transfer of transfers) {
    add(transfer.currency, transfer.from, transfer.amountMinor);
    add(transfer.currency, transfer.to, -transfer.amountMinor);
  }
  return balances;
}

export interface SuggestedTransfer<U> {
  readonly from: U;
  readonly to: U;
  readonly amountMinor: number;
}

// The largest debtor pays the largest creditor until everyone is square: at most n - 1
// transfers. Ties go to the earlier member.
export function greedyTransfers<U>(balances: ReadonlyMap<U, number>): SuggestedTransfer<U>[] {
  const left = new Map(balances);
  const transfers: SuggestedTransfer<U>[] = [];
  for (;;) {
    let debtor: [U, number] | undefined;
    let creditor: [U, number] | undefined;
    for (const entry of left) {
      if (entry[1] < 0 && (debtor === undefined || entry[1] < debtor[1])) debtor = entry;
      if (entry[1] > 0 && (creditor === undefined || entry[1] > creditor[1])) creditor = entry;
    }
    if (debtor === undefined || creditor === undefined) return transfers;
    const amountMinor = Math.min(-debtor[1], creditor[1]);
    transfers.push({ from: debtor[0], to: creditor[0], amountMinor });
    left.set(debtor[0], debtor[1] + amountMinor);
    left.set(creditor[0], creditor[1] - amountMinor);
  }
}

// The first 8 hex digits of a SHA-256 over the transfer list: a [Перевёл] tap carries it, so a
// list that changed since it was shown is caught.
export function transfersHash<U>(
  transfers: readonly (SuggestedTransfer<U> & { readonly currency: CurrencyCode })[],
): string {
  const canonical = JSON.stringify(
    transfers.map((t) => [String(t.from), String(t.to), t.amountMinor, t.currency]),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}
