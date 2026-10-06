import type { CategoryId } from '../db/categories.js';
import type { Db } from '../db/connection.js';
import type { DebtPersonId } from '../db/debts.js';
import type { ExpenseId } from '../db/expenses.js';
import {
  clearPendingFlow,
  completePendingFlow,
  findFlowSession,
  savePendingFlow,
  saveScreenAnchor,
} from '../db/flowSessions.js';
import type { LedgerId } from '../db/ledgers.js';
import type { RuleId } from '../db/recurring.js';
import type { User } from '../db/users.js';
import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { DebtDirection } from '../domain/debts.js';
import type { LocalDate } from '../domain/time.js';

// ADR-0009's session row, typed: the user's screen anchor (ADR-0011) and at most one pending
// text flow. It lives in SQLite, so both survive a restart.

// A flow's answer is accepted for this long after its prompt.
export const FLOW_TTL_MS = 10 * 60 * 1000;
// A non-expense text this soon after a flow expired gets flowExpired instead of help.
export const EXPIRED_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CategoriesScreen {
  readonly name: 'categories';
  readonly ledgerId: LedgerId;
  // Opened from the settings hub: the screen carries a [« Назад] back to it.
  readonly fromSettings?: true;
}

// A /week or /month summary. Paging reads this ledger, not the one active at tap time.
export interface SummaryScreen {
  readonly name: 'summary';
  readonly ledgerId: LedgerId;
}

// An expense card holding an edit prompt: the card is the edit flow's anchor.
export interface ExpenseScreen {
  readonly name: 'expense';
  readonly expenseId: ExpenseId;
}

// The /settings hub; with `ledgerId`, the hub scoped to that shared ledger (its timezone and
// currency), opened from its group's /settings deep link.
export interface SettingsScreen {
  readonly name: 'settings';
  readonly ledgerId?: LedgerId;
}

// The /budget screen of one ledger (ADR-0017). Its setup taps act on this ledger.
export interface BudgetScreen {
  readonly name: 'budget';
  readonly ledgerId: LedgerId;
  // Opened from a settings hub: the screen carries a [« Назад] back to it.
  readonly fromSettings?: true;
}

// /recurring (Plan 0025): the rule list, one rule's screen with `ruleId`, or the reminder
// schedule picker holding the reminder text typed for it.
export interface RecurringScreen {
  readonly name: 'recurring';
  readonly ruleId?: RuleId;
  readonly reminderText?: string;
}

// An `ask` occurrence's prompt holding [Другая сумма]'s amount prompt: the flow's anchor.
export interface RecurringAskScreen {
  readonly name: 'recurringAsk';
  readonly ruleId: RuleId;
  readonly dueOn: LocalDate;
}

// /debts (Plan 0013): the debts list, and the lend/borrow prompts and person picker it opens;
// with `personId`, that person's card and its repayment prompts.
export interface DebtsScreen {
  readonly name: 'debts';
  readonly personId?: DebtPersonId;
}

export type Screen =
  | CategoriesScreen
  | SummaryScreen
  | ExpenseScreen
  | SettingsScreen
  | BudgetScreen
  | RecurringScreen
  | RecurringAskScreen
  | DebtsScreen;

export interface ScreenAnchor {
  readonly chatId: number;
  readonly messageId: number;
  readonly screen: Screen;
}

export type CategoryFlow =
  | { readonly kind: 'categoryAdd'; readonly ledgerId: LedgerId }
  | {
      readonly kind: 'categoryRename';
      readonly ledgerId: LedgerId;
      readonly categoryId: CategoryId;
    };

// Editing one field of an expense from its card.
export interface EditFlow {
  readonly kind: 'editAmount' | 'editDescription' | 'editDate';
  readonly expenseId: ExpenseId;
}

const EDIT_FLOW_KINDS: ReadonlySet<string> = new Set<EditFlow['kind']>([
  'editAmount',
  'editDescription',
  'editDate',
]);

export function isEditFlow(flow: Flow): flow is EditFlow {
  return EDIT_FLOW_KINDS.has(flow.kind);
}

// [Другой…]: the user's own zone, or with `ledgerId` the shared ledger's.
export interface TimezoneFlow {
  readonly kind: 'setTimezone';
  readonly ledgerId?: LedgerId;
}

// A budget setting typed into the budget screen of `ledgerId`: its limit, its period start day,
// or one category's cap.
export type BudgetFlow =
  | { readonly kind: 'budgetLimit' | 'budgetStartDay'; readonly ledgerId: LedgerId }
  | { readonly kind: 'budgetCap'; readonly ledgerId: LedgerId; readonly categoryId: CategoryId };

const BUDGET_FLOW_KINDS: ReadonlySet<string> = new Set<BudgetFlow['kind']>([
  'budgetLimit',
  'budgetStartDay',
  'budgetCap',
]);

export function isBudgetFlow(flow: Flow): flow is BudgetFlow {
  return BUDGET_FLOW_KINDS.has(flow.kind);
}

// A secret typed for the sealed ledger `ledgerId` (ADR-0020): the passphrase that switches
// encryption on or unlocks it, the recovery code, or a new passphrase, asked in the settings
// anchor (`passphraseChange`) or after a recovery code (`recoverPassphrase`). The payload never
// holds the secret: it is consumed in the update that carries it.
export interface SecretFlow {
  readonly kind:
    'encryptionEnable' | 'unlock' | 'recoverCode' | 'recoverPassphrase' | 'passphraseChange';
  readonly ledgerId: LedgerId;
}

const SECRET_FLOW_KINDS: ReadonlySet<string> = new Set<SecretFlow['kind']>([
  'encryptionEnable',
  'unlock',
  'recoverCode',
  'recoverPassphrase',
  'passphraseChange',
]);

function isSecretKind(kind: string): kind is SecretFlow['kind'] {
  return SECRET_FLOW_KINDS.has(kind);
}

export function isSecretFlow(flow: Flow): flow is SecretFlow {
  return isSecretKind(flow.kind);
}

// [Другая сумма] under an `ask` occurrence's prompt: the amount to record for it.
export interface RecurringAmountFlow {
  readonly kind: 'recurringAmount';
  readonly ruleId: RuleId;
  readonly dueOn: LocalDate;
}

// [Добавить напоминание] on /recurring: the reminder's text.
export interface ReminderTextFlow {
  readonly kind: 'reminderText';
}

// [Я дал в долг] / [Я взял в долг] on /debts: the amount, then the person, who is picked by
// button or typed as a name.
export interface DebtAmountFlow {
  readonly kind: 'debtAmount';
  readonly direction: DebtDirection;
}

export interface DebtPersonFlow {
  readonly kind: 'debtPerson';
  readonly direction: DebtDirection;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

// [Мне вернули] / [Я вернул] on a person's card: a repayment of their balance in `currency`.
export interface DebtRepayFlow {
  readonly kind: 'debtRepay';
  readonly personId: DebtPersonId;
  readonly currency: CurrencyCode;
}

export type Flow =
  | CategoryFlow
  | EditFlow
  | TimezoneFlow
  | BudgetFlow
  | SecretFlow
  | RecurringAmountFlow
  | ReminderTextFlow
  | DebtAmountFlow
  | DebtPersonFlow
  | DebtRepayFlow;

type Deps = { readonly db: Db };

export function currentAnchor({ db }: Deps, user: User): ScreenAnchor | undefined {
  const anchor = findFlowSession(db, user.id)?.anchor ?? null;
  if (anchor === null) return undefined;
  const screen = parseScreen(anchor.screen, anchor.screenCtx);
  return screen === undefined
    ? undefined
    : { chatId: anchor.chatId, messageId: anchor.messageId, screen };
}

export function setAnchor({ db }: Deps, user: User, anchor: ScreenAnchor): void {
  const { name, ...screenCtx } = anchor.screen;
  saveScreenAnchor(db, user.id, {
    chatId: anchor.chatId,
    messageId: anchor.messageId,
    screen: name,
    screenCtx: JSON.stringify(screenCtx),
  });
}

// Starts a flow, replacing any pending one (ADR-0009).
export function startFlow({ db }: Deps, user: User, flow: Flow, now: Date): void {
  const { kind, ...payload } = flow;
  savePendingFlow(db, user.id, {
    kind,
    payload: JSON.stringify(payload),
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS),
  });
}

// Returns false when nothing was pending.
export function cancelFlow({ db }: Deps, user: User): boolean {
  return clearPendingFlow(db, user.id);
}

// Cancels the pending flow only when `matches` accepts it, so a card tap clears its own card's
// flow and leaves an unrelated one pending. Returns false when nothing was cleared.
export function cancelFlowIf(deps: Deps, user: User, matches: (flow: Flow) => boolean): boolean {
  const pending = findFlowSession(deps.db, user.id)?.pending ?? null;
  if (pending === null) return false;
  const flow = parseFlow(pending.kind, pending.payload);
  if (flow === undefined || !matches(flow)) return false;
  return cancelFlow(deps, user);
}

// The pending flow while it is still answerable, for a tap that answers it.
export function currentFlow(deps: Deps, user: User, now: Date): Flow | undefined {
  const pending = findFlowSession(deps.db, user.id)?.pending ?? null;
  if (pending === null || now.getTime() >= pending.expiresAt.getTime()) return undefined;
  return parseFlow(pending.kind, pending.payload);
}

// The pending flow is an edit of this expense's field (any field when `kind` is omitted).
export function isEditOf(expenseId: ExpenseId, kind?: EditFlow['kind']): (flow: Flow) => boolean {
  return (flow) =>
    isEditFlow(flow) && flow.expenseId === expenseId && (kind === undefined || flow.kind === kind);
}

// Marks the pending flow answered by this input. Run it in the transaction that applies the
// answer, so a redelivery either finds both or neither.
export function completeFlow({ db }: Deps, user: User, inputKey: string): void {
  if (!completePendingFlow(db, user.id, inputKey)) throw new Error('no flow to complete');
}

export type TextRoute =
  // The answer that last completed a flow, delivered again: record nothing, reply nothing.
  | { readonly kind: 'redelivered' }
  | { readonly kind: 'flow'; readonly flow: Flow }
  // The first text after a secret prompt (ADR-0020) expired, within the reply window: it may
  // carry the passphrase or the code, so it is never read as an expense.
  | { readonly kind: 'expiredSecret' }
  // Free text: an expense attempt. `expiredFlow` when a flow expired within the reply window.
  | { readonly kind: 'free'; readonly expiredFlow: boolean };

// ADR-0009's routing for a text that is neither a command nor a menu tap.
export function routeText(
  { db }: Deps,
  input: { readonly user: User; readonly inputKey: string; readonly now: Date },
): TextRoute {
  const session = findFlowSession(db, input.user.id);
  if (session === undefined) return { kind: 'free', expiredFlow: false };
  if (session.lastInputKey === input.inputKey) return { kind: 'redelivered' };
  const { pending } = session;
  if (pending === null) return { kind: 'free', expiredFlow: false };
  const now = input.now.getTime();
  const expiresAt = pending.expiresAt.getTime();
  if (now < expiresAt) {
    const flow = parseFlow(pending.kind, pending.payload);
    if (flow !== undefined) return { kind: 'flow', flow };
  }
  const inWindow = now < expiresAt + EXPIRED_REPLY_WINDOW_MS;
  if (inWindow && isSecretKind(pending.kind)) return { kind: 'expiredSecret' };
  return { kind: 'free', expiredFlow: inWindow };
}

// A row written by a later version, or damaged, reads as no screen rather than failing.
function parseScreen(name: string, ctx: string): Screen | undefined {
  const parsed = parseObject(ctx);
  if (name === 'settings' && parsed !== undefined) {
    return typeof parsed.ledgerId === 'string'
      ? { name, ledgerId: parsed.ledgerId as LedgerId }
      : { name };
  }
  if (name === 'summary' && typeof parsed?.ledgerId === 'string') {
    return { name, ledgerId: parsed.ledgerId as LedgerId };
  }
  if (name === 'expense' && typeof parsed?.expenseId === 'string') {
    return { name, expenseId: parsed.expenseId as ExpenseId };
  }
  if (name === 'recurring' && parsed !== undefined) {
    return {
      name,
      ...(typeof parsed.ruleId === 'string' ? { ruleId: parsed.ruleId as RuleId } : {}),
      ...(typeof parsed.reminderText === 'string' ? { reminderText: parsed.reminderText } : {}),
    };
  }
  if (
    name === 'recurringAsk' &&
    typeof parsed?.ruleId === 'string' &&
    typeof parsed.dueOn === 'string'
  ) {
    return { name, ruleId: parsed.ruleId as RuleId, dueOn: parsed.dueOn as LocalDate };
  }
  if (name === 'debts' && parsed !== undefined) {
    return typeof parsed.personId === 'number'
      ? { name, personId: parsed.personId as DebtPersonId }
      : { name };
  }
  if ((name === 'budget' || name === 'categories') && typeof parsed?.ledgerId === 'string') {
    const ledgerId = parsed.ledgerId as LedgerId;
    return parsed.fromSettings === true
      ? { name, ledgerId, fromSettings: true }
      : { name, ledgerId };
  }
  return undefined;
}

function parseFlow(kind: string, payload: string): Flow | undefined {
  const parsed = parseObject(payload);
  if (kind === 'setTimezone' && parsed !== undefined) {
    return typeof parsed.ledgerId === 'string'
      ? { kind, ledgerId: parsed.ledgerId as LedgerId }
      : { kind };
  }
  if (
    (kind === 'editAmount' || kind === 'editDescription' || kind === 'editDate') &&
    typeof parsed?.expenseId === 'string'
  ) {
    return { kind, expenseId: parsed.expenseId as ExpenseId };
  }
  if (
    kind === 'recurringAmount' &&
    typeof parsed?.ruleId === 'string' &&
    typeof parsed.dueOn === 'string'
  ) {
    return { kind, ruleId: parsed.ruleId as RuleId, dueOn: parsed.dueOn as LocalDate };
  }
  if (kind === 'reminderText' && parsed !== undefined) return { kind };
  if (kind === 'debtRepay' && typeof parsed?.personId === 'number') {
    const currency =
      typeof parsed.currency === 'string' ? toCurrencyCode(parsed.currency) : undefined;
    if (currency === undefined) return undefined;
    return { kind, personId: parsed.personId as DebtPersonId, currency };
  }
  const direction = parseDirection(parsed?.direction);
  if (kind === 'debtAmount' && direction !== undefined) return { kind, direction };
  if (kind === 'debtPerson' && direction !== undefined) {
    const currency =
      typeof parsed?.currency === 'string' ? toCurrencyCode(parsed.currency) : undefined;
    const { amountMinor } = parsed ?? {};
    if (currency === undefined || !Number.isSafeInteger(amountMinor)) return undefined;
    return { kind, direction, amountMinor: amountMinor as number, currency };
  }
  if (typeof parsed?.ledgerId !== 'string') return undefined;
  const ledgerId = parsed.ledgerId as LedgerId;
  if (isSecretKind(kind)) return { kind, ledgerId };
  if (kind === 'categoryAdd' || kind === 'budgetLimit' || kind === 'budgetStartDay') {
    return { kind, ledgerId };
  }
  if (
    (kind === 'categoryRename' || kind === 'budgetCap') &&
    typeof parsed.categoryId === 'number'
  ) {
    return { kind, ledgerId, categoryId: parsed.categoryId as CategoryId };
  }
  return undefined;
}

function parseDirection(value: unknown): DebtDirection | undefined {
  return value === 'lend' || value === 'borrow' ? value : undefined;
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
