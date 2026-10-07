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
import type { StatementPeriod, StatementPurchase } from '../domain/statements/types.js';
import { parseLocalDate, type LocalDate } from '../domain/time.js';

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

// A summary's period by its pager key (periodKey()).
export interface PeriodRef {
  readonly kind: 'week' | 'month';
  readonly key: string;
}

// The summary's drill-down (Plan 0037): the category picker on a page, or one category's
// expense list on a page; `expenseId` once a number opened that expense's card in the anchor
// (ADR-0040). `categoryId` null is the uncategorized list.
export type Drill =
  | { readonly level: 'picker'; readonly period: PeriodRef; readonly page: number }
  | {
      readonly level: 'list';
      readonly period: PeriodRef;
      readonly categoryId: CategoryId | null;
      readonly page: number;
      readonly expenseId?: ExpenseId;
    };

// A /week or /month summary. Paging reads this ledger, not the one active at tap time. Without
// `drill`, the screen shows the digest (or its items).
export interface SummaryScreen {
  readonly name: 'summary';
  readonly ledgerId: LedgerId;
  readonly drill?: Drill;
}

// An expense card holding an edit prompt: the card is the edit flow's anchor. A prompt started
// from a card inside a summary drill-down keeps that summary screen in `returnTo`, and the anchor
// becomes it again when the prompt is over (ADR-0040).
export interface ExpenseScreen {
  readonly name: 'expense';
  readonly expenseId: ExpenseId;
  readonly returnTo?: SummaryScreen;
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
  // The split picker after a `/N` expense: who owes a part of it.
  readonly splitOf?: ExpenseId;
}

// A [☰ Ещё] button's argument prompt (Plan 0034): its [Отмена] and /cancel need an anchor.
export interface CommandArgScreen {
  readonly name: 'commandArg';
}

// /prices (ADR-0039): the product list of `ledgerId` and the products it opens. A review holds
// its normalized item names in `names` and the one being answered at `position`; with `product`,
// the names are that product's, opened from its [Названия], and an answer goes back to it.
// `newProduct` is the name typed for [Новый продукт], awaiting its unit: the step a unit tap
// consumes, so a double tap creates one product.
export interface PricesScreen {
  readonly name: 'prices';
  readonly ledgerId: LedgerId;
  readonly names?: readonly string[];
  readonly position?: number;
  readonly product?: string;
  readonly newProduct?: string;
}

export type Screen =
  | CommandArgScreen
  | PricesScreen
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
  readonly kind: 'editAmount' | 'editDescription' | 'editDate' | 'editTags';
  readonly expenseId: ExpenseId;
}

const EDIT_FLOW_KINDS: ReadonlySet<string> = new Set<EditFlow['kind']>([
  'editAmount',
  'editDescription',
  'editDate',
  'editTags',
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

// The split picker after a `/N` expense: `needed` people, each owing `each` in `currency`, are
// toggled by button or typed as names; `chosen` holds them so far.
export interface DebtSplitFlow {
  readonly kind: 'debtSplit';
  readonly expenseId: ExpenseId;
  readonly each: number;
  readonly currency: CurrencyCode;
  readonly needed: number;
  readonly chosen: readonly DebtPersonId[];
}

// The commands a [☰ Ещё] button asks the argument for, then runs as `/<command> <answer>`.
export const ARG_COMMANDS = ['block', 'unblock', 'refund', 'paysupport', 'tag'] as const;

export type ArgCommand = (typeof ARG_COMMANDS)[number];

function isArgCommand(value: unknown): value is ArgCommand {
  return (ARG_COMMANDS as readonly unknown[]).includes(value);
}

export interface CommandArgFlow {
  readonly kind: 'commandArg';
  readonly command: ArgCommand;
}

// [Новый продукт] in the /prices picker (ADR-0039): the new product's name, typed into the
// anchor of the prices screen of `ledgerId`.
export interface ProductNameFlow {
  readonly kind: 'productName';
  readonly ledgerId: LedgerId;
}

export type Flow =
  | CommandArgFlow
  | ProductNameFlow
  | CategoryFlow
  | EditFlow
  | TimezoneFlow
  | BudgetFlow
  | SecretFlow
  | RecurringAmountFlow
  | ReminderTextFlow
  | DebtAmountFlow
  | DebtPersonFlow
  | DebtRepayFlow
  | DebtSplitFlow;

// A parsed bank statement awaiting [Записать все] (Plan 0027). It shares the pending-flow slot
// and its TTL, but takes no typed answer: text routes as if nothing were pending.
export const STATEMENT_FLOW = 'statementImport';

export interface StatementFlow {
  readonly ledgerId: LedgerId;
  readonly period: StatementPeriod | undefined;
  readonly purchases: readonly StatementPurchase[];
}

type Deps = { readonly db: Db };

// Holds a statement's purchases for the buttons under its preview, replacing any pending flow.
export function startStatementFlow({ db }: Deps, user: User, flow: StatementFlow, now: Date): void {
  savePendingFlow(db, user.id, {
    kind: STATEMENT_FLOW,
    payload: JSON.stringify(flow),
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS),
  });
}

// The pending statement, unless it expired, was replaced by another flow, or can't be read.
export function pendingStatementFlow(
  { db }: Deps,
  user: User,
  now: Date,
): StatementFlow | undefined {
  const pending = findFlowSession(db, user.id)?.pending ?? null;
  if (pending === null || pending.kind !== STATEMENT_FLOW) return undefined;
  if (now.getTime() >= pending.expiresAt.getTime()) return undefined;
  return parseStatementFlow(pending.payload);
}

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
// flow and leaves an unrelated one pending. Returns false when nothing was cleared. A cancelled
// edit hands the anchor back to the screen its prompt replaced (returnFromPrompt).
export function cancelFlowIf(deps: Deps, user: User, matches: (flow: Flow) => boolean): boolean {
  const pending = findFlowSession(deps.db, user.id)?.pending ?? null;
  if (pending === null) return false;
  const flow = parseFlow(pending.kind, pending.payload);
  if (flow === undefined || !matches(flow)) return false;
  if (!cancelFlow(deps, user)) return false;
  if (isEditFlow(flow)) returnFromPrompt(deps, user, flow.expenseId);
  return true;
}

// ADR-0040: once an edit prompt of this expense is over, an anchor that is its ExpenseScreen with
// a `returnTo` becomes that summary screen again, so the card it re-renders keeps its
// [« Назад]. Any other anchor is left as it is.
export function returnFromPrompt(deps: Deps, user: User, expenseId: ExpenseId): void {
  const anchor = currentAnchor(deps, user);
  if (
    anchor?.screen.name !== 'expense' ||
    anchor.screen.expenseId !== expenseId ||
    anchor.screen.returnTo === undefined
  ) {
    return;
  }
  setAnchor(deps, user, { ...anchor, screen: anchor.screen.returnTo });
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
  if (pending === null || pending.kind === STATEMENT_FLOW)
    return { kind: 'free', expiredFlow: false };
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
  if (name === 'commandArg' && parsed !== undefined) return { name };
  if (name === 'settings' && parsed !== undefined) {
    return typeof parsed.ledgerId === 'string'
      ? { name, ledgerId: parsed.ledgerId as LedgerId }
      : { name };
  }
  if (name === 'summary' && parsed !== undefined) return parseSummary(parsed);
  if (name === 'prices' && typeof parsed?.ledgerId === 'string') {
    const { names, position, product, newProduct } = parsed;
    const review =
      Array.isArray(names) && names.every((n) => typeof n === 'string') ? { names } : {};
    return {
      name,
      ledgerId: parsed.ledgerId as LedgerId,
      ...review,
      ...(Number.isSafeInteger(position) ? { position: position as number } : {}),
      ...(typeof product === 'string' ? { product } : {}),
      ...(typeof newProduct === 'string' ? { newProduct } : {}),
    };
  }
  if (name === 'expense' && typeof parsed?.expenseId === 'string') {
    const returnTo =
      typeof parsed.returnTo === 'object' && parsed.returnTo !== null
        ? parseSummary(parsed.returnTo as Record<string, unknown>)
        : undefined;
    return {
      name,
      expenseId: parsed.expenseId as ExpenseId,
      ...(returnTo === undefined ? {} : { returnTo }),
    };
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
    return {
      name,
      ...(typeof parsed.personId === 'number' ? { personId: parsed.personId as DebtPersonId } : {}),
      ...(typeof parsed.splitOf === 'string' ? { splitOf: parsed.splitOf as ExpenseId } : {}),
    };
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
  if (kind === 'commandArg' && isArgCommand(parsed?.command)) {
    return { kind, command: parsed.command };
  }
  if (kind === 'setTimezone' && parsed !== undefined) {
    return typeof parsed.ledgerId === 'string'
      ? { kind, ledgerId: parsed.ledgerId as LedgerId }
      : { kind };
  }
  if (
    (kind === 'editAmount' ||
      kind === 'editDescription' ||
      kind === 'editDate' ||
      kind === 'editTags') &&
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
  if (kind === 'debtSplit' && typeof parsed?.expenseId === 'string') {
    const currency =
      typeof parsed.currency === 'string' ? toCurrencyCode(parsed.currency) : undefined;
    const { each, needed, chosen } = parsed;
    if (
      currency === undefined ||
      !Number.isSafeInteger(each) ||
      !Number.isSafeInteger(needed) ||
      !Array.isArray(chosen) ||
      !chosen.every((id) => Number.isSafeInteger(id))
    ) {
      return undefined;
    }
    return {
      kind,
      expenseId: parsed.expenseId as ExpenseId,
      each: each as number,
      currency,
      needed: needed as number,
      chosen: chosen as DebtPersonId[],
    };
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
  if (
    kind === 'categoryAdd' ||
    kind === 'budgetLimit' ||
    kind === 'budgetStartDay' ||
    kind === 'productName'
  ) {
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

function parseSummary(parsed: Record<string, unknown>): SummaryScreen | undefined {
  if (typeof parsed.ledgerId !== 'string') return undefined;
  const drill = parseDrill(parsed.drill);
  return {
    name: 'summary',
    ledgerId: parsed.ledgerId as LedgerId,
    ...(drill === undefined ? {} : { drill }),
  };
}

// A damaged drill reads as none: the screen is then the digest's.
function parseDrill(value: unknown): Drill | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { level, period, page, categoryId, expenseId } = value as Record<string, unknown>;
  const ref = period as Record<string, unknown> | undefined;
  const kind = ref?.kind;
  if (
    (kind !== 'week' && kind !== 'month') ||
    typeof ref?.key !== 'string' ||
    !Number.isSafeInteger(page)
  ) {
    return undefined;
  }
  const at: { period: PeriodRef; page: number } = {
    period: { kind, key: ref.key },
    page: page as number,
  };
  if (level === 'picker') return { level, ...at };
  if (level !== 'list' || (categoryId !== null && !Number.isSafeInteger(categoryId))) {
    return undefined;
  }
  return {
    level,
    ...at,
    categoryId: categoryId as CategoryId | null,
    ...(typeof expenseId === 'string' ? { expenseId: expenseId as ExpenseId } : {}),
  };
}

function parseDirection(value: unknown): DebtDirection | undefined {
  return value === 'lend' || value === 'borrow' ? value : undefined;
}

function parseStatementFlow(payload: string): StatementFlow | undefined {
  const parsed = parseObject(payload);
  if (typeof parsed?.ledgerId !== 'string' || !Array.isArray(parsed.purchases)) return undefined;
  const purchases: StatementPurchase[] = [];
  for (const raw of parsed.purchases as unknown[]) {
    const purchase = parseStatementPurchase(raw);
    if (purchase === undefined) return undefined;
    purchases.push(purchase);
  }
  const period = parsed.period as Record<string, unknown> | undefined;
  const from = typeof period?.from === 'string' ? parseLocalDate(period.from) : undefined;
  const to = typeof period?.to === 'string' ? parseLocalDate(period.to) : undefined;
  return {
    ledgerId: parsed.ledgerId as LedgerId,
    period: from === undefined || to === undefined ? undefined : { from, to },
    purchases,
  };
}

function parseStatementPurchase(raw: unknown): StatementPurchase | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  const date = typeof fields.date === 'string' ? parseLocalDate(fields.date) : undefined;
  const currency =
    typeof fields.currency === 'string' ? toCurrencyCode(fields.currency) : undefined;
  const { amountMinor, merchant, debitRsdMinor, ordinal } = fields;
  if (
    date === undefined ||
    currency === undefined ||
    !Number.isSafeInteger(amountMinor) ||
    typeof amountMinor !== 'number' ||
    typeof merchant !== 'string' ||
    typeof debitRsdMinor !== 'number' ||
    !Number.isSafeInteger(debitRsdMinor) ||
    typeof ordinal !== 'number' ||
    !Number.isSafeInteger(ordinal)
  ) {
    return undefined;
  }
  return { date, amountMinor, currency, merchant, debitRsdMinor, ordinal };
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
