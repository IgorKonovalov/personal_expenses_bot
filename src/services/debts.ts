import {
  findDebtOpBySourceKey,
  findDebtPerson,
  findDebtPersonByKey,
  insertDebtOpOrGetExisting,
  insertDebtPerson,
  listDebtOps,
  listDebtPeople,
  type DebtOp,
  type DebtOpId,
  type DebtPerson,
  type DebtPersonId,
} from '../db/debts.js';
import { findPersonalLedger } from '../db/ledgers.js';
import type { User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import {
  debtBalances,
  parseDebtAmount,
  parsePersonName,
  sortDebtLines,
  type DebtDirection,
  type DebtKind,
} from '../domain/debts.js';
import type { Money } from '../domain/money.js';
import { localDateOf } from '../domain/time.js';
import {
  completeFlow,
  currentFlow,
  startFlow,
  type DebtAmountFlow,
  type DebtPersonFlow,
} from './flowSessions.js';
import type { KeyDeps } from './ledgerKeys.js';
import type { RecordDeps } from './recordExpense.js';
import { resolveUserTimezone } from './settings.js';

// Personal debts (ADR-0030): operations against a per-user list of people, balanced per person
// and currency on read. Debts are never expenses: nothing here touches a ledger's totals. Every
// operation carries the update's source key, so a redelivery records nothing twice. Logs carry
// ids only, never a name or an amount.

export type DebtDeps = RecordDeps &
  Pick<KeyDeps, 'keys'> & {
    // The currency of an amount typed without a code, for a user with no personal ledger.
    readonly defaultCurrency: CurrencyCode;
  };

export interface DebtLine extends Money {
  readonly personId: DebtPersonId;
  readonly name: string;
}

// /debts: one line per person and non-zero currency, people who owe the user first.
export function debtLines(deps: Pick<DebtDeps, 'db'>, user: User): DebtLine[] {
  const people = new Map(listDebtPeople(deps.db, user.id).map((p) => [p.id, p]));
  const lines = debtBalances(listDebtOps(deps.db, user.id)).flatMap((balance) => {
    const person = people.get(balance.personId);
    return person === undefined ? [] : [{ ...balance, name: person.name }];
  });
  return sortDebtLines(lines);
}

// The user's people by name: the person picker's choices.
export function debtPeople(deps: Pick<DebtDeps, 'db'>, user: User): DebtPerson[] {
  return listDebtPeople(deps.db, user.id).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
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
): DebtAmountFlow {
  const flow: DebtAmountFlow = { kind: 'debtAmount', direction };
  startFlow(deps, user, flow, now);
  return flow;
}

export type DebtAmountAnswer =
  // The flow stays pending and the prompt is asked again.
  | { readonly kind: 'invalid'; readonly currency: CurrencyCode }
  | { readonly kind: 'askPerson'; readonly flow: DebtPersonFlow };

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
  | { readonly kind: 'invalid'; readonly reason: 'empty' | 'tooLong' };

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
  const parsed = parsePersonName(input.text);
  if (parsed.kind === 'invalid') return parsed;
  return deps.db.transaction((): DebtRecorded => {
    completeFlow(deps, user, input.inputKey);
    const person =
      findDebtPersonByKey(deps.db, user.id, parsed.key) ??
      createPerson(deps, user, parsed.name, parsed.key, input.now);
    return recordOp(deps, {
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
): DebtRecorded | { readonly kind: 'stale' } {
  const { user } = input;
  return deps.db.transaction((): DebtRecorded | { readonly kind: 'stale' } => {
    const seen = findDebtOpBySourceKey(deps.db, input.sourceKey);
    if (seen !== undefined) return recordedOf(deps, user, seen);
    const flow = currentFlow(deps, user, input.now);
    const person = findDebtPerson(deps.db, user.id, input.personId);
    if (flow?.kind !== 'debtPerson' || person === undefined) return { kind: 'stale' };
    completeFlow(deps, user, input.sourceKey);
    return recordOp(deps, {
      user,
      person,
      kind: KIND_OF[flow.direction],
      money: { amountMinor: flow.amountMinor, currency: flow.currency },
      sourceKey: input.sourceKey,
      now: input.now,
    });
  })();
}

function createPerson(
  deps: DebtDeps,
  user: User,
  name: string,
  nameKey: string,
  now: Date,
): DebtPerson {
  const person = insertDebtPerson(deps.db, { userId: user.id, name, nameKey, createdAt: now });
  deps.logger.info({ personId: person.id, userId: user.id }, 'debt person added');
  return person;
}

// One operation dated the user's today, under `sourceKey`: a key seen before returns the stored
// operation.
function recordOp(
  deps: DebtDeps,
  input: {
    readonly user: User;
    readonly person: DebtPerson;
    readonly kind: DebtKind;
    readonly money: Money;
    readonly sourceKey: string;
    readonly now: Date;
  },
): DebtRecorded {
  const { user, person, money } = input;
  const { op, created } = insertDebtOpOrGetExisting(deps.db, {
    id: deps.newId() as DebtOpId,
    userId: user.id,
    personId: person.id,
    kind: input.kind,
    amountMinor: money.amountMinor,
    currency: money.currency,
    occurredOn: localDateOf(input.now, resolveUserTimezone(deps, user)),
    expenseId: null,
    sourceKey: input.sourceKey,
    createdAt: input.now,
  });
  deps.logger.info(
    { debtOpId: op.id, personId: op.personId, userId: user.id, duplicate: !created },
    'debt recorded',
  );
  return { kind: 'recorded', op, person, balance: personBalance(deps, user, op) };
}

// A stored operation as a recorded result, for a redelivery.
function recordedOf(deps: DebtDeps, user: User, op: DebtOp): DebtRecorded {
  const person = findDebtPerson(deps.db, user.id, op.personId);
  if (person === undefined) throw new Error(`debt operation ${op.id} has no person`);
  return { kind: 'recorded', op, person, balance: personBalance(deps, user, op) };
}

function personBalance(deps: Pick<DebtDeps, 'db'>, user: User, op: DebtOp): Money {
  const balance = debtBalances(listDebtOps(deps.db, user.id)).find(
    (b) => b.personId === op.personId && b.currency === op.currency,
  );
  return { amountMinor: balance?.amountMinor ?? 0, currency: op.currency };
}
