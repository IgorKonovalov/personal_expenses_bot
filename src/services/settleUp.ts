import { listLedgerExpenses } from '../db/expenses.js';
import { joinMember, listMembers, type Ledger } from '../db/ledgers.js';
import {
  findTransfer,
  insertTransferOrGetExisting,
  listLedgerTransfers,
  softDeleteTransfer,
  type Transfer,
  type TransferId,
} from '../db/transfers.js';
import { findUserByIdentity, type UserId } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import {
  greedyTransfers,
  settleBalances,
  transfersHash,
  type SuggestedTransfer,
} from '../domain/settleUp.js';
import { localDateOf } from '../domain/time.js';
import { boundLedger } from './groupChats.js';
import { plaintext } from './ledgerKeys.js';
import { provisionUser } from './provisionUser.js';
import { resolveLedgerTimezone, type RecordDeps } from './recordExpense.js';

// /settle in a bound group (ADR-0030): computed on every read from the group's live expenses,
// its members' join dates and its recorded transfers. A shared ledger is never sealed (ADR-0020),
// so every expense is plaintext. Logs carry ids only.

export type SettleDeps = RecordDeps & { readonly defaultCurrency: CurrencyCode };

export interface SettleMemberView {
  readonly id: UserId;
  // Null for a deleted account.
  readonly name: string | null;
}

export interface SettleCurrency {
  readonly currency: CurrencyCode;
  readonly balances: readonly (SettleMemberView & { readonly amountMinor: number })[];
  readonly transfers: readonly SuggestedTransfer<UserId>[];
}

export interface SettleView {
  readonly ledger: Ledger;
  readonly members: readonly SettleMemberView[];
  // Only the currencies with something owed.
  readonly currencies: readonly SettleCurrency[];
  // Every currency's transfers in order: what a [Перевёл] index points at.
  readonly transfers: readonly (SuggestedTransfer<UserId> & { readonly currency: CurrencyCode })[];
  readonly hash: string;
}

// The settle-up of the chat's bound ledger; undefined for an unbound chat.
export function settleView(deps: SettleDeps, chatId: number): SettleView | undefined {
  const ledger = boundLedger(deps, chatId);
  if (ledger?.timezone == null) return undefined;
  const timezone = resolveLedgerTimezone(deps, { id: ledger.id, timezone: ledger.timezone });
  const members = listMembers(deps.db, ledger.id);
  const [first] = members;
  const expenses =
    first === undefined
      ? []
      : listLedgerExpenses(deps.db, { ledgerId: ledger.id, memberId: first.userId }).map(plaintext);
  const balances = settleBalances(
    members.map((m) => ({ id: m.userId, joinedOn: localDateOf(m.joinedAt, timezone) })),
    expenses.map((e) => ({
      paidBy: e.createdBy,
      amountMinor: e.amountMinor,
      currency: e.currency,
      occurredOn: e.occurredOn,
    })),
    listLedgerTransfers(deps.db, ledger.id).map((t) => ({
      from: t.fromUser,
      to: t.toUser,
      amountMinor: t.amountMinor,
      currency: t.currency,
    })),
  );
  const names = new Map(members.map((m) => [m.userId, m.displayName]));
  const currencies = [...balances.entries()]
    .sort(([a], [b]) =>
      a === ledger.defaultCurrency ? -1 : b === ledger.defaultCurrency ? 1 : a.localeCompare(b),
    )
    .map(([currency, byMember]) => ({
      currency,
      balances: [...byMember.entries()].map(([id, amountMinor]) => ({
        id,
        name: names.get(id) ?? null,
        amountMinor,
      })),
      transfers: greedyTransfers(byMember),
    }))
    .filter((c) => c.transfers.length > 0);
  const transfers = currencies.flatMap((c) =>
    c.transfers.map((t) => ({ ...t, currency: c.currency })),
  );
  return {
    ledger,
    members: members.map((m) => ({ id: m.userId, name: m.displayName })),
    currencies,
    transfers,
    hash: transfersHash(transfers),
  };
}

function telegramUser(deps: SettleDeps, telegramId: number): UserId | undefined {
  return findUserByIdentity(deps.db, 'telegram', String(telegramId))?.id;
}

// [Я тоже участвую]: the tapper joins the ledger now, and shares expenses from today on.
export function joinSettle(
  deps: SettleDeps,
  input: {
    readonly chatId: number;
    readonly telegramId: number;
    readonly firstName: string;
    readonly now: Date;
  },
): 'joined' | 'already' | 'unbound' {
  const ledger = boundLedger(deps, input.chatId);
  if (ledger?.timezone == null) return 'unbound';
  const { timezone } = ledger;
  return deps.db.transaction(() => {
    const { user } = provisionUser(deps, {
      provider: 'telegram',
      externalId: String(input.telegramId),
      defaultTimezone: timezone,
      defaultCurrency: ledger.defaultCurrency,
      now: input.now,
    });
    const joined = joinMember(deps.db, {
      ledgerId: ledger.id,
      userId: user.id,
      displayName: input.firstName,
      joinedAt: input.now,
    });
    if (joined) deps.logger.info({ ledgerId: ledger.id, userId: user.id }, 'settle member joined');
    return joined ? 'joined' : 'already';
  })();
}

export type TransferResult =
  | { readonly kind: 'recorded'; readonly transfer: Transfer; readonly view: SettleView }
  // The list changed since the tapped message showed it.
  | { readonly kind: 'stale'; readonly view: SettleView | undefined }
  | { readonly kind: 'notParty' };

// [Перевёл] on transfer `index` of the list hashed `hash`: only its payer or receiver records
// it, and only while the recomputed list still hashes the same. Keyed by the tap.
export function recordTransfer(
  deps: SettleDeps,
  input: {
    readonly chatId: number;
    readonly telegramId: number;
    readonly index: number;
    readonly hash: string;
    readonly sourceKey: string;
    readonly now: Date;
  },
): TransferResult {
  return deps.db.transaction((): TransferResult => {
    const view = settleView(deps, input.chatId);
    const suggested = view?.transfers[input.index];
    if (view === undefined || view.hash !== input.hash || suggested === undefined) {
      return { kind: 'stale', view };
    }
    const tapper = telegramUser(deps, input.telegramId);
    if (tapper !== suggested.from && tapper !== suggested.to) return { kind: 'notParty' };
    const { transfer, created } = insertTransferOrGetExisting(deps.db, {
      id: deps.newId() as TransferId,
      ledgerId: view.ledger.id,
      fromUser: suggested.from,
      toUser: suggested.to,
      amountMinor: suggested.amountMinor,
      currency: suggested.currency,
      createdBy: tapper,
      sourceKey: input.sourceKey,
      createdAt: input.now,
    });
    if (created) {
      deps.logger.info({ transferId: transfer.id, ledgerId: view.ledger.id }, 'transfer recorded');
    }
    const after = settleView(deps, input.chatId);
    if (after === undefined) throw new Error('a bound chat lost its ledger mid-transfer');
    return { kind: 'recorded', transfer, view: after };
  })();
}

export type DeleteTransferResult =
  | { readonly kind: 'deleted'; readonly transfer: Transfer }
  | { readonly kind: 'alreadyDeleted' | 'notParty' | 'notFound' };

// [Удалить] under a recorded transfer: its payer or receiver only.
export function deleteTransfer(
  deps: SettleDeps,
  input: {
    readonly chatId: number;
    readonly telegramId: number;
    readonly transferId: TransferId;
    readonly now: Date;
  },
): DeleteTransferResult {
  const ledger = boundLedger(deps, input.chatId);
  const transfer = findTransfer(deps.db, input.transferId);
  if (ledger === undefined || transfer?.ledgerId !== ledger.id) return { kind: 'notFound' };
  const tapper = telegramUser(deps, input.telegramId);
  if (tapper !== transfer.fromUser && tapper !== transfer.toUser) return { kind: 'notParty' };
  if (!softDeleteTransfer(deps.db, transfer.id, input.now)) return { kind: 'alreadyDeleted' };
  deps.logger.info({ transferId: transfer.id, ledgerId: ledger.id }, 'transfer deleted');
  return { kind: 'deleted', transfer };
}
