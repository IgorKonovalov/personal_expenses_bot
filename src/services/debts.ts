import type { KeyObject } from 'node:crypto';
import {
  findDebtOp,
  findDebtOpBySourceKey,
  findDebtPerson,
  findDebtPersonByKey,
  insertDebtOpOrGetExisting,
  insertDebtPerson,
  insertSealedDebtPerson,
  listDebtOps,
  listDebtPeople,
  listPersonOps,
  softDeleteDebtOp,
  type DebtOp,
  type DebtOpId,
  type DebtPerson,
  type DebtPersonId,
  type NewDebtOp,
  type StoredDebtOp,
  type StoredDebtPerson,
} from '../db/debts.js';
import { findPersonalLedger, type LedgerId } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import {
  checkRepayment,
  debtBalances,
  parseDebtAmount,
  parsePersonName,
  personNameKey,
  repaymentKind,
  sortDebtLines,
  type DebtDirection,
  type DebtKind,
} from '../domain/debts.js';
import { parseExpenseText } from '../domain/expenseText.js';
import type { Money } from '../domain/money.js';
import {
  debtOpBinding,
  debtPersonBinding,
  decodeDebtOp,
  decodeDebtPerson,
  encodeDebtOp,
  encodeDebtPerson,
  open,
  seal,
} from '../domain/sealing.js';
import { localDateOf } from '../domain/time.js';
import {
  cancelFlow,
  completeFlow,
  currentFlow,
  startFlow,
  type DebtAmountFlow,
  type DebtPersonFlow,
  type DebtRepayFlow,
  type DebtSplitFlow,
} from './flowSessions.js';
import type { ExpenseId } from '../db/expenses.js';
import { LOCKED, sealingKey, type KeyDeps, type Locked } from './ledgerKeys.js';
import type { RecordDeps } from './recordExpense.js';
import { resolveUserTimezone } from './settings.js';

// Personal debts (ADR-0030): operations against a per-user list of people, balanced per person
// and currency on read. Debts are never expenses: nothing here touches a ledger's totals. Every
// operation carries the update's source key, so a redelivery records nothing twice. Logs carry
// ids only, never a name or an amount.
//
// In a sealed personal ledger (ADR-0020) a new person's name, and a new operation's kind, amount
// and currency, are sealed to the ledger's key. Every debts screen shows names, so while that
// ledger is locked nothing of the debts is read or written: each entry point answers `locked`.

export type DebtDeps = RecordDeps &
  Pick<KeyDeps, 'keys'> & {
    // The currency of an amount typed without a code, for a user with no personal ledger.
    readonly defaultCurrency: CurrencyCode;
  };

type ReadDeps = Pick<DebtDeps, 'db' | 'keys'>;

// How the user's debts are written and read: plaintext, or sealed to the personal ledger's key
// and opened with its unlocked private key.
type DebtSeal =
  | { readonly kind: 'plain' }
  | {
      readonly kind: 'sealed';
      readonly ledgerId: LedgerId;
      readonly publicKey: Buffer;
      readonly privateKey: KeyObject;
    };

const PLAIN: DebtSeal = { kind: 'plain' };

function debtSeal(deps: ReadDeps, user: User): DebtSeal | Locked {
  const ledger = findPersonalLedger(deps.db, user.id);
  const publicKey = ledger === undefined ? undefined : sealingKey(deps, ledger.id);
  if (ledger === undefined || publicKey === undefined) return PLAIN;
  const privateKey = deps.keys.privateKey(ledger.id);
  if (privateKey === undefined) return LOCKED;
  return { kind: 'sealed', ledgerId: ledger.id, publicKey, privateKey };
}

// The user's personal ledger is sealed and locked: no debts screen opens.
export function debtsLocked(deps: ReadDeps, user: User): boolean {
  return debtSeal(deps, user).kind === 'locked';
}

// A row recorded before the ledger was sealed stays plaintext, and passes through.
function openPerson(s: DebtSeal, stored: StoredDebtPerson): DebtPerson {
  if (!('sealed' in stored)) return stored;
  if (s.kind !== 'sealed') throw new Error(`sealed debt person ${String(stored.id)} unopened`);
  const { name } = decodeDebtPerson(
    open(stored.sealed, s.privateKey, debtPersonBinding(s.ledgerId, stored.id)),
  );
  return { id: stored.id, userId: stored.userId, name };
}

function openOp(s: DebtSeal, stored: StoredDebtOp): DebtOp {
  if (!('sealed' in stored)) return stored;
  if (s.kind !== 'sealed') throw new Error(`sealed debt operation ${stored.id} unopened`);
  const { sealed, ...rest } = stored;
  const payload = decodeDebtOp(open(sealed, s.privateKey, debtOpBinding(s.ledgerId, stored.id)));
  return {
    ...rest,
    kind: payload.kind,
    amountMinor: payload.amountMinor,
    currency: payload.currency,
  };
}

function peopleOf(deps: ReadDeps, s: DebtSeal, user: User): DebtPerson[] {
  return listDebtPeople(deps.db, user.id).map((p) => openPerson(s, p));
}

function personOf(
  deps: ReadDeps,
  s: DebtSeal,
  user: User,
  personId: DebtPersonId,
): DebtPerson | undefined {
  const stored = findDebtPerson(deps.db, user.id, personId);
  return stored === undefined ? undefined : openPerson(s, stored);
}

function opsOf(deps: ReadDeps, s: DebtSeal, user: User): DebtOp[] {
  return listDebtOps(deps.db, user.id).map((op) => openOp(s, op));
}

// The person with this name, ignoring case. A sealed name has no key column, so a sealed ledger
// matches against the opened names.
function personByKey(deps: ReadDeps, s: DebtSeal, user: User, key: string): DebtPerson | undefined {
  if (s.kind === 'plain') return findDebtPersonByKey(deps.db, user.id, key);
  return peopleOf(deps, s, user).find((p) => personNameKey(p.name) === key);
}

export interface DebtLine extends Money {
  readonly personId: DebtPersonId;
  readonly name: string;
}

// /debts: one line per person and non-zero currency, people who owe the user first.
export function debtLines(deps: ReadDeps, user: User): DebtLine[] | Locked {
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const people = new Map(peopleOf(deps, s, user).map((p) => [p.id, p]));
  const lines = debtBalances(opsOf(deps, s, user)).flatMap((balance) => {
    const person = people.get(balance.personId);
    return person === undefined ? [] : [{ ...balance, name: person.name }];
  });
  return sortDebtLines(lines);
}

// The user's people by name: the person picker's choices.
export function debtPeople(deps: ReadDeps, user: User): DebtPerson[] | Locked {
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  return peopleOf(deps, s, user).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// The currency an amount without a code is in: the personal ledger's.
export function debtCurrency(deps: Pick<DebtDeps, 'db' | 'defaultCurrency'>, user: User) {
  return findPersonalLedger(deps.db, user.id)?.defaultCurrency ?? deps.defaultCurrency;
}

// [Я дал в долг] / [Я взял в долг]: the amount prompt's flow (ADR-0009).
export function startDebt(
  deps: DebtDeps,
  user: User,
  direction: DebtDirection,
  now: Date,
): DebtAmountFlow | Locked {
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const flow: DebtAmountFlow = { kind: 'debtAmount', direction };
  startFlow(deps, user, flow, now);
  return flow;
}

export type DebtAmountAnswer =
  // The flow stays pending and the prompt is asked again.
  | { readonly kind: 'invalid'; readonly currency: CurrencyCode }
  | { readonly kind: 'askPerson'; readonly flow: DebtPersonFlow }
  | Locked;

// A typed amount: valid, the flow moves on to the person, in one transaction with the answer.
export function answerDebtAmount(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly flow: DebtAmountFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): DebtAmountAnswer {
  const { user } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const currency = debtCurrency(deps, user);
  const amount = parseDebtAmount(input.text, currency);
  if (amount.kind !== 'ok') return { kind: 'invalid', currency };
  const flow: DebtPersonFlow = {
    kind: 'debtPerson',
    direction: input.flow.direction,
    amountMinor: amount.amountMinor,
    currency: amount.currency,
  };
  deps.db.transaction(() => {
    completeFlow(deps, user, input.inputKey);
    startFlow(deps, user, flow, input.now);
  })();
  return { kind: 'askPerson', flow };
}

export interface DebtRecorded {
  readonly kind: 'recorded';
  readonly op: DebtOp;
  readonly person: DebtPerson;
  // The person's balance in the operation's currency after it; zero when settled.
  readonly balance: Money;
}

export type DebtPersonAnswer =
  | DebtRecorded
  // The flow stays pending and the person is asked again.
  | { readonly kind: 'invalid'; readonly reason: NameRefusal }
  | Locked;

export type NameRefusal = 'empty' | 'tooLong' | 'expenseShaped';

const KIND_OF: Record<DebtDirection, DebtKind> = { lend: 'lend', borrow: 'borrow' };

// A typed name: an existing person with that name, ignoring case, else a new one. Records the
// operation under the answer's key and completes the flow in one transaction.
export function answerDebtPersonName(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly flow: DebtPersonFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): DebtPersonAnswer {
  const { user, flow } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const parsed = personNameOf(deps, user, input.text);
  if (parsed.kind === 'invalid') return parsed;
  return deps.db.transaction((): DebtRecorded => {
    completeFlow(deps, user, input.inputKey);
    const person =
      personByKey(deps, s, user, parsed.key) ??
      createPerson(deps, s, user, parsed.name, parsed.key, input.now);
    return recordOp(deps, s, {
      user,
      person,
      kind: KIND_OF[flow.direction],
      money: { amountMinor: flow.amountMinor, currency: flow.currency },
      sourceKey: input.inputKey,
      now: input.now,
    });
  })();
}

// A person picked by button for the pending person step, under the tap's key. A redelivered tap
// finds the operation it recorded. `stale` when no person step is pending, or the person isn't
// the user's.
export function pickDebtPerson(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly personId: DebtPersonId;
    readonly sourceKey: string;
    readonly now: Date;
  },
): DebtRecorded | { readonly kind: 'stale' } | Locked {
  const { user } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  return deps.db.transaction((): DebtRecorded | { readonly kind: 'stale' } => {
    const seen = findDebtOpBySourceKey(deps.db, input.sourceKey);
    if (seen !== undefined) return recordedOf(deps, s, user, openOp(s, seen));
    const flow = currentFlow(deps, user, input.now);
    const person = personOf(deps, s, user, input.personId);
    if (flow?.kind !== 'debtPerson' || person === undefined) return { kind: 'stale' };
    completeFlow(deps, user, input.sourceKey);
    return recordOp(deps, s, {
      user,
      person,
      kind: KIND_OF[flow.direction],
      money: { amountMinor: flow.amountMinor, currency: flow.currency },
      sourceKey: input.sourceKey,
      now: input.now,
    });
  })();
}

// A person's card shows this many of their latest operations.
export const HISTORY_SIZE = 10;

export interface PersonCard {
  readonly person: DebtPerson;
  // Each non-zero balance, by currency.
  readonly balances: readonly Money[];
  // The latest live operations, newest first.
  readonly history: readonly DebtOp[];
}

// One of the user's people with their balances and history; undefined for anyone else's.
export function personCard(
  deps: ReadDeps,
  user: User,
  personId: DebtPersonId,
): PersonCard | undefined | Locked {
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const person = personOf(deps, s, user, personId);
  if (person === undefined) return undefined;
  return {
    person,
    balances: personBalances(deps, s, user, personId),
    history: listPersonOps(deps.db, user.id, personId, HISTORY_SIZE).map((op) => openOp(s, op)),
  };
}

function personBalances(deps: ReadDeps, s: DebtSeal, user: User, personId: DebtPersonId): Money[] {
  return debtBalances(opsOf(deps, s, user))
    .filter((b) => b.personId === personId)
    .map(({ amountMinor, currency }) => ({ amountMinor, currency }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

// [Мне вернули] repays what they owe me, [Я вернул] what I owe them.
export type RepayDirection = 'toMe' | 'byMe';

export type RepayStart =
  // The person has more than one balance that way: which currency.
  | { readonly kind: 'pickCurrency'; readonly balances: readonly Money[] }
  | { readonly kind: 'askAmount'; readonly flow: DebtRepayFlow; readonly balance: Money }
  // Nothing to repay that way, or in that currency.
  | { readonly kind: 'nothing' }
  | Locked;

// Starts the repayment amount prompt, for the one balance that way or the `currency` picked.
export function startRepay(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly personId: DebtPersonId;
    readonly direction: RepayDirection;
    readonly currency?: CurrencyCode;
    readonly now: Date;
  },
): RepayStart {
  const { user, currency } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const balances = personBalances(deps, s, user, input.personId).filter((b) =>
    input.direction === 'toMe' ? b.amountMinor > 0 : b.amountMinor < 0,
  );
  const chosen =
    currency === undefined
      ? balances.length === 1
        ? balances[0]
        : undefined
      : balances.find((b) => b.currency === currency);
  if (chosen === undefined) {
    return currency === undefined && balances.length > 1
      ? { kind: 'pickCurrency', balances }
      : { kind: 'nothing' };
  }
  const flow: DebtRepayFlow = {
    kind: 'debtRepay',
    personId: input.personId,
    currency: chosen.currency,
  };
  startFlow(deps, user, flow, input.now);
  return { kind: 'askAmount', flow, balance: chosen };
}

export type RepayAnswer =
  | DebtRecorded
  // The flow stays pending and the prompt is asked again.
  | {
      readonly kind: 'refused';
      readonly reason: 'invalid' | 'wrongCurrency' | 'tooMuch';
      readonly balance: Money;
    }
  // The balance was settled meanwhile: the flow is cleared.
  | { readonly kind: 'gone' }
  | Locked;

// A typed repayment: an amount in the debt's currency, at most its balance.
export function answerRepayAmount(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly flow: DebtRepayFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): RepayAnswer {
  const { user, flow } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const balance = repayBalance(deps, s, user, flow);
  if (balance === undefined) {
    cancelFlow(deps, user);
    return { kind: 'gone' };
  }
  const amount = parseDebtAmount(input.text, flow.currency);
  if (amount.kind !== 'ok') return { kind: 'refused', reason: 'invalid', balance };
  const check = checkRepayment(balance, amount);
  if (check.kind === 'wrongCurrency' || check.kind === 'tooMuch') {
    return { kind: 'refused', reason: check.kind, balance };
  }
  return deps.db.transaction((): DebtRecorded => {
    completeFlow(deps, user, input.inputKey);
    return recordRepayment(deps, s, user, flow, balance, amount.amountMinor, {
      sourceKey: input.inputKey,
      now: input.now,
    });
  })();
}

// [Весь долг]: the whole balance of the pending repayment, under the tap's key. A redelivered tap
// finds the operation it recorded.
export function repayAll(
  deps: DebtDeps,
  input: { readonly user: User; readonly sourceKey: string; readonly now: Date },
): DebtRecorded | { readonly kind: 'stale' } | Locked {
  const { user } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  return deps.db.transaction((): DebtRecorded | { readonly kind: 'stale' } => {
    const seen = findDebtOpBySourceKey(deps.db, input.sourceKey);
    if (seen !== undefined) return recordedOf(deps, s, user, openOp(s, seen));
    const flow = currentFlow(deps, user, input.now);
    if (flow?.kind !== 'debtRepay') return { kind: 'stale' };
    const balance = repayBalance(deps, s, user, flow);
    if (balance === undefined) return { kind: 'stale' };
    completeFlow(deps, user, input.sourceKey);
    return recordRepayment(deps, s, user, flow, balance, Math.abs(balance.amountMinor), input);
  })();
}

// The person's non-zero balance in the flow's currency.
function repayBalance(
  deps: DebtDeps,
  s: DebtSeal,
  user: User,
  flow: DebtRepayFlow,
): Money | undefined {
  return personBalances(deps, s, user, flow.personId).find((b) => b.currency === flow.currency);
}

function recordRepayment(
  deps: DebtDeps,
  s: DebtSeal,
  user: User,
  flow: DebtRepayFlow,
  balance: Money,
  amountMinor: number,
  input: { readonly now: Date; readonly sourceKey: string },
): DebtRecorded {
  const person = personOf(deps, s, user, flow.personId);
  if (person === undefined) throw new Error(`repayment to a missing person ${flow.personId}`);
  return recordOp(deps, s, {
    user,
    person,
    kind: repaymentKind(balance.amountMinor),
    money: { amountMinor, currency: balance.currency },
    sourceKey: input.sourceKey,
    now: input.now,
  });
}

// The split picker's flow after a `/N` expense: `parts - 1` people, each owing `each`. `locked`
// while a sealed ledger is locked: the picker would show names, so no flow starts.
export function startSplit(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly expenseId: ExpenseId;
    readonly each: number;
    readonly currency: CurrencyCode;
    readonly parts: number;
    // The expense message's key: it counts as answered, so its redelivery is ignored instead of
    // read as a name (ADR-0009).
    readonly sourceKey: string;
    readonly now: Date;
  },
): DebtSplitFlow | Locked {
  const s = debtSeal(deps, input.user);
  if (s.kind === 'locked') return s;
  const flow: DebtSplitFlow = {
    kind: 'debtSplit',
    expenseId: input.expenseId,
    each: input.each,
    currency: input.currency,
    needed: input.parts - 1,
    chosen: [],
  };
  deps.db.transaction(() => {
    startFlow(deps, input.user, flow, input.now);
    completeFlow(deps, input.user, input.sourceKey);
    startFlow(deps, input.user, flow, input.now);
  })();
  return flow;
}

// A typed name that reads as an expense is refused: it is most likely one, sent mid-flow.
function personNameOf(deps: DebtDeps, user: User, text: string) {
  const asExpense = parseExpenseText(text, debtCurrency(deps, user)).kind;
  if (asExpense === 'expense' || asExpense === 'ambiguous') {
    return { kind: 'invalid', reason: 'expenseShaped' } as const;
  }
  return parsePersonName(text);
}

export type SplitStep = { readonly kind: 'picking'; readonly flow: DebtSplitFlow };

// A person's button in the split picker: chosen, or unchosen when already chosen.
export function toggleSplitPerson(
  deps: DebtDeps,
  input: { readonly user: User; readonly personId: DebtPersonId; readonly now: Date },
): SplitStep | { readonly kind: 'stale' } | Locked {
  const { user } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const flow = currentFlow(deps, user, input.now);
  const person = findDebtPerson(deps.db, user.id, input.personId);
  if (flow?.kind !== 'debtSplit' || person === undefined) return { kind: 'stale' };
  const chosen = flow.chosen.includes(person.id)
    ? flow.chosen.filter((id) => id !== person.id)
    : [...flow.chosen, person.id];
  const next: DebtSplitFlow = { ...flow, chosen };
  startFlow(deps, user, next, input.now);
  return { kind: 'picking', flow: next };
}

// A name typed into the split picker: the person with that name, or a new one, is chosen.
export function answerSplitName(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly flow: DebtSplitFlow;
    readonly text: string;
    readonly inputKey: string;
    readonly now: Date;
  },
): SplitStep | { readonly kind: 'invalid'; readonly reason: NameRefusal } | Locked {
  const { user, flow } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const parsed = personNameOf(deps, user, input.text);
  if (parsed.kind === 'invalid') return parsed;
  return deps.db.transaction((): SplitStep => {
    const person =
      personByKey(deps, s, user, parsed.key) ??
      createPerson(deps, s, user, parsed.name, parsed.key, input.now);
    const next: DebtSplitFlow = flow.chosen.includes(person.id)
      ? flow
      : { ...flow, chosen: [...flow.chosen, person.id] };
    completeFlow(deps, user, input.inputKey);
    startFlow(deps, user, next, input.now);
    return { kind: 'picking', flow: next };
  })();
}

export type SplitFinish =
  | { readonly kind: 'recorded'; readonly people: readonly DebtPerson[]; readonly each: Money }
  // Fewer or more than the parts need are chosen: nothing is recorded.
  | { readonly kind: 'notReady'; readonly flow: DebtSplitFlow }
  | { readonly kind: 'stale' }
  | Locked;

// [Готово]: one lend of `each` per chosen person, in the expense's currency, keyed by the
// expense and the person, so nothing is recorded twice.
export function finishSplit(
  deps: DebtDeps,
  input: { readonly user: User; readonly now: Date },
): SplitFinish {
  const { user } = input;
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  return deps.db.transaction((): SplitFinish => {
    const flow = currentFlow(deps, user, input.now);
    if (flow?.kind !== 'debtSplit') return { kind: 'stale' };
    if (flow.chosen.length !== flow.needed) return { kind: 'notReady', flow };
    cancelFlow(deps, user);
    const each = { amountMinor: flow.each, currency: flow.currency };
    const people = flow.chosen.flatMap((personId) => {
      const person = personOf(deps, s, user, personId);
      if (person === undefined) return [];
      recordOp(deps, s, {
        user,
        person,
        kind: 'lend',
        money: each,
        sourceKey: `split:${flow.expenseId}:${person.id}`,
        expenseId: flow.expenseId,
        now: input.now,
      });
      return [person];
    });
    return { kind: 'recorded', people, each };
  })();
}

// [Пропустить]: the expense stays at the user's share and no debt is recorded.
export function skipSplit(deps: DebtDeps, user: User, now: Date): boolean {
  return currentFlow(deps, user, now)?.kind === 'debtSplit' && cancelFlow(deps, user);
}

export type DeleteDebtResult =
  | (Omit<DebtRecorded, 'kind'> & { readonly kind: 'deleted' })
  | { readonly kind: 'alreadyDeleted' | 'notFound' }
  // Nothing is deleted while a sealed ledger is locked.
  | Locked;

// [Удалить] on a confirmation: soft-deletes the user's own operation; a second tap finds it gone.
export function deleteDebtOp(
  deps: DebtDeps,
  input: { readonly user: User; readonly opId: DebtOpId; readonly now: Date },
): DeleteDebtResult {
  const { user } = input;
  const stored = findDebtOp(deps.db, input.opId);
  if (stored === undefined || stored.userId !== user.id) return { kind: 'notFound' };
  const s = debtSeal(deps, user);
  if (s.kind === 'locked') return s;
  const op = openOp(s, stored);
  const person = personOf(deps, s, user, op.personId);
  if (person === undefined) return { kind: 'notFound' };
  if (!softDeleteDebtOp(deps.db, op.id, input.now)) return { kind: 'alreadyDeleted' };
  deps.logger.info({ debtOpId: op.id, userId: user.id }, 'debt deleted');
  return { kind: 'deleted', op, person, balance: personBalance(deps, s, user, op) };
}

function createPerson(
  deps: DebtDeps,
  s: DebtSeal,
  user: User,
  name: string,
  nameKey: string,
  now: Date,
): DebtPerson {
  const person =
    s.kind === 'plain'
      ? insertDebtPerson(deps.db, { userId: user.id, name, nameKey, createdAt: now })
      : insertSealedDebtPerson(deps.db, {
          userId: user.id,
          createdAt: now,
          seal: (id) =>
            seal(s.publicKey, encodeDebtPerson({ v: 1, name }), debtPersonBinding(s.ledgerId, id)),
        });
  deps.logger.info({ personId: person.id, userId: user.id }, 'debt person added');
  return { id: person.id, userId: person.userId, name };
}

// One operation dated the user's today, under `sourceKey`: a key seen before returns the stored
// operation.
function recordOp(
  deps: DebtDeps,
  s: DebtSeal,
  input: {
    readonly user: User;
    readonly person: DebtPerson;
    readonly kind: DebtKind;
    readonly money: Money;
    readonly sourceKey: string;
    readonly now: Date;
    // The split expense a lend comes from.
    readonly expenseId?: ExpenseId;
  },
): DebtRecorded {
  const { user, person, money } = input;
  const id = deps.newId() as DebtOpId;
  const common = {
    id,
    userId: user.id,
    personId: person.id,
    occurredOn: localDateOf(input.now, resolveUserTimezone(deps, user)),
    expenseId: input.expenseId ?? null,
    sourceKey: input.sourceKey,
    createdAt: input.now,
  };
  const row: NewDebtOp =
    s.kind === 'plain'
      ? { ...common, kind: input.kind, amountMinor: money.amountMinor, currency: money.currency }
      : {
          ...common,
          sealed: seal(
            s.publicKey,
            encodeDebtOp({
              v: 1,
              kind: input.kind,
              amountMinor: money.amountMinor,
              currency: money.currency,
            }),
            debtOpBinding(s.ledgerId, id),
          ),
        };
  const { op: stored, created } = insertDebtOpOrGetExisting(deps.db, row);
  const op = openOp(s, stored);
  deps.logger.info(
    { debtOpId: op.id, personId: op.personId, userId: user.id, duplicate: !created },
    'debt recorded',
  );
  return { kind: 'recorded', op, person, balance: personBalance(deps, s, user, op) };
}

// A stored operation as a recorded result, for a redelivery.
function recordedOf(deps: DebtDeps, s: DebtSeal, user: User, op: DebtOp): DebtRecorded {
  const person = personOf(deps, s, user, op.personId);
  if (person === undefined) throw new Error(`debt operation ${op.id} has no person`);
  return { kind: 'recorded', op, person, balance: personBalance(deps, s, user, op) };
}

function personBalance(deps: ReadDeps, s: DebtSeal, user: User, op: DebtOp): Money {
  const balance = debtBalances(opsOf(deps, s, user)).find(
    (b) => b.personId === op.personId && b.currency === op.currency,
  );
  return { amountMinor: balance?.amountMinor ?? 0, currency: op.currency };
}
