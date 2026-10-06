import { toCurrencyCode, type CurrencyCode } from '../domain/currencies.js';
import type { Schedule } from '../domain/schedule.js';
import type { LocalDate } from '../domain/time.js';
import type { CategoryId } from './categories.js';
import type { Db } from './connection.js';
import type { ExpenseId } from './expenses.js';
import type { LedgerId } from './ledgers.js';
import type { User, UserId } from './users.js';

// Recurring rules and their occurrences (ADR-0031). A rule's next due date is a local date; the
// occurrence table's key (rule, due date) is what makes each occurrence happen once.

export type RuleId = string & { readonly __brand: 'RuleId' };

export type RuleKind = 'expense' | 'reminder';
export type RuleMode = 'auto' | 'ask';
export type OccurrenceOutcome = 'recorded' | 'asked' | 'reminded' | 'skipped';

// What each occurrence of an expense rule records.
export interface RuleTemplate {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly description: string;
  readonly categoryId: CategoryId | null;
}

// A sealed ledger's template (ADR-0035): amount, description and category sealed under the
// rule's binding; the currency stays plaintext, as on an expense row.
export interface SealedRuleTemplate {
  readonly currency: CurrencyCode;
  readonly sealed: Buffer;
}

export interface RecurringRule {
  readonly id: RuleId;
  // NULL for a reminder.
  readonly ledgerId: LedgerId | null;
  readonly userId: UserId;
  readonly kind: RuleKind;
  readonly mode: RuleMode;
  // A plaintext expense rule's template; NULL for a reminder or a sealed template.
  readonly template: RuleTemplate | null;
  // An expense rule's sealed template; NULL otherwise.
  readonly sealedTemplate: SealedRuleTemplate | null;
  readonly reminderText: string | null;
  readonly schedule: Schedule;
  readonly nextDueOn: LocalDate;
  readonly pausedAt: Date | null;
  readonly deletedAt: Date | null;
}

export type NewRule = Omit<RecurringRule, 'pausedAt' | 'deletedAt'> & {
  readonly sourceKey: string | null;
  readonly createdAt: Date;
};

interface RuleRow {
  id: string;
  ledger_id: string | null;
  user_id: string;
  kind: RuleKind;
  mode: RuleMode;
  amount_minor: number | null;
  currency: string | null;
  description: string | null;
  category_id: number | null;
  sealed: Buffer | null;
  reminder_text: string | null;
  schedule: string;
  day: number | null;
  weekday: number | null;
  month: number | null;
  next_due_on: string;
  paused_at: string | null;
  deleted_at: string | null;
}

const COLUMNS = `id, ledger_id, user_id, kind, mode, amount_minor, currency, description,
  category_id, sealed, reminder_text, schedule, day, weekday, month, next_due_on, paused_at,
  deleted_at`;

// Inserts unless a live rule has the same source key; either way returns the stored rule.
export function insertRuleOrGetExisting(
  db: Db,
  rule: NewRule,
): { rule: RecurringRule; created: boolean } {
  if (rule.sourceKey !== null) {
    const existing = findLiveRuleBySourceKey(db, rule.sourceKey);
    if (existing !== undefined) return { rule: existing, created: false };
  }
  const { day, weekday, month } = scheduleColumns(rule.schedule);
  db.prepare<
    [
      string,
      string | null,
      string,
      string,
      string,
      number | null,
      string | null,
      string | null,
      number | null,
      Buffer | null,
      string | null,
      string,
      number | null,
      number | null,
      number | null,
      string,
      string | null,
      string,
    ]
  >(
    `INSERT INTO recurring_rules (id, ledger_id, user_id, kind, mode, amount_minor, currency,
                                  description, category_id, sealed, reminder_text, schedule, day,
                                  weekday, month, next_due_on, source_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rule.id,
    rule.ledgerId,
    rule.userId,
    rule.kind,
    rule.mode,
    rule.template?.amountMinor ?? null,
    rule.template?.currency ?? rule.sealedTemplate?.currency ?? null,
    rule.template?.description ?? null,
    rule.template?.categoryId ?? null,
    rule.sealedTemplate?.sealed ?? null,
    rule.reminderText,
    rule.schedule.kind,
    day,
    weekday,
    month,
    rule.nextDueOn,
    rule.sourceKey,
    rule.createdAt.toISOString(),
  );
  const stored = findRule(db, rule.id);
  if (stored === undefined) throw new Error('rule vanished after insert');
  return { rule: stored, created: true };
}

function findLiveRuleBySourceKey(db: Db, sourceKey: string): RecurringRule | undefined {
  const row = db
    .prepare<[string], RuleRow>(
      `SELECT ${COLUMNS} FROM recurring_rules WHERE source_key = ? AND deleted_at IS NULL`,
    )
    .get(sourceKey);
  return row === undefined ? undefined : toRule(row);
}

// A rule by id, deleted or not.
export function findRule(db: Db, id: RuleId): RecurringRule | undefined {
  const row = db
    .prepare<[string], RuleRow>(`SELECT ${COLUMNS} FROM recurring_rules WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : toRule(row);
}

// The user's rules that aren't deleted, soonest first.
export function listUserRules(db: Db, userId: UserId): RecurringRule[] {
  return db
    .prepare<[string], RuleRow>(
      `SELECT ${COLUMNS} FROM recurring_rules
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY next_due_on, created_at, id`,
    )
    .all(userId)
    .map(toRule);
}

// Live, unpaused rules whose next due date is on or before `latest`: the candidates a tick
// checks against each rule's own timezone.
export function listRulesDueBy(db: Db, latest: LocalDate): RecurringRule[] {
  return db
    .prepare<[string], RuleRow>(
      `SELECT ${COLUMNS} FROM recurring_rules
        WHERE next_due_on <= ? AND deleted_at IS NULL AND paused_at IS NULL
        ORDER BY next_due_on, id`,
    )
    .all(latest)
    .map(toRule);
}

// Moves the next due date from `from` to `to`. Returns false when it no longer reads `from`, or
// the rule was deleted or paused since: another tick got there first.
export function advanceRule(db: Db, id: RuleId, from: LocalDate, to: LocalDate): boolean {
  const { changes } = db
    .prepare<[string, string, string]>(
      `UPDATE recurring_rules SET next_due_on = ?
        WHERE id = ? AND next_due_on = ? AND deleted_at IS NULL AND paused_at IS NULL`,
    )
    .run(to, id, from);
  return changes === 1;
}

// Claims an occurrence. Returns false when (rule, due date) already happened.
export function insertOccurrenceOrIgnore(
  db: Db,
  occurrence: {
    readonly ruleId: RuleId;
    readonly dueOn: LocalDate;
    readonly outcome: OccurrenceOutcome;
    readonly expenseId: ExpenseId | null;
  },
): boolean {
  const { changes } = db
    .prepare<[string, string, string, string | null]>(
      `INSERT INTO recurring_occurrences (rule_id, due_on, outcome, expense_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (rule_id, due_on) DO NOTHING`,
    )
    .run(occurrence.ruleId, occurrence.dueOn, occurrence.outcome, occurrence.expenseId);
  return changes === 1;
}

export function findOccurrenceOutcome(
  db: Db,
  ruleId: RuleId,
  dueOn: LocalDate,
): OccurrenceOutcome | undefined {
  return db
    .prepare<[string, string], OccurrenceOutcome>(
      'SELECT outcome FROM recurring_occurrences WHERE rule_id = ? AND due_on = ?',
    )
    .pluck()
    .get(ruleId, dueOn);
}

// Answers an `asked` occurrence. Returns false when it was answered already.
export function answerAskedOccurrence(
  db: Db,
  occurrence: {
    readonly ruleId: RuleId;
    readonly dueOn: LocalDate;
    readonly outcome: 'recorded' | 'skipped';
    readonly expenseId: ExpenseId | null;
  },
): boolean {
  const { changes } = db
    .prepare<[string, string | null, string, string]>(
      `UPDATE recurring_occurrences SET outcome = ?, expense_id = ?
        WHERE rule_id = ? AND due_on = ? AND outcome = 'asked'`,
    )
    .run(occurrence.outcome, occurrence.expenseId, occurrence.ruleId, occurrence.dueOn);
  return changes === 1;
}

// Returns false when the rule is deleted or already in that mode.
export function setRuleMode(db: Db, id: RuleId, mode: RuleMode): boolean {
  const { changes } = db
    .prepare<[string, string, string]>(
      `UPDATE recurring_rules SET mode = ?
        WHERE id = ? AND deleted_at IS NULL AND mode <> ? AND kind = 'expense'`,
    )
    .run(mode, id, mode);
  return changes === 1;
}

// Stops a rule from firing, e.g. once its author left the ledger. Returns false when it was
// already paused or deleted.
export function pauseRule(db: Db, id: RuleId, pausedAt: Date): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      `UPDATE recurring_rules SET paused_at = ?
        WHERE id = ? AND paused_at IS NULL AND deleted_at IS NULL`,
    )
    .run(pausedAt.toISOString(), id);
  return changes === 1;
}

// Returns false when the rule was already deleted. Its recorded expenses stay.
export function softDeleteRule(db: Db, id: RuleId, deletedAt: Date): boolean {
  const { changes } = db
    .prepare<[string, string]>(
      'UPDATE recurring_rules SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(deletedAt.toISOString(), id);
  return changes === 1;
}

// The ledger's expense rules whose template is still plaintext, deleted ones included: what
// sealing the ledger seals.
export function listLedgerPlaintextRules(db: Db, ledgerId: LedgerId): RecurringRule[] {
  return db
    .prepare<[string], RuleRow>(
      `SELECT ${COLUMNS} FROM recurring_rules
        WHERE ledger_id = ? AND kind = 'expense' AND sealed IS NULL
        ORDER BY rowid`,
    )
    .all(ledgerId)
    .map(toRule);
}

// Turns a plaintext template into a sealed one: `sealed` holds what the amount, description and
// category held, and they are cleared; the currency stays. Returns false when it is sealed
// already.
export function sealRuleTemplateInPlace(db: Db, id: RuleId, sealed: Buffer): boolean {
  const { changes } = db
    .prepare<[Buffer, string]>(
      `UPDATE recurring_rules
          SET sealed = ?, amount_minor = NULL, description = NULL, category_id = NULL
        WHERE id = ? AND kind = 'expense' AND sealed IS NULL`,
    )
    .run(sealed, id);
  return changes === 1;
}

// A rule's author, and the Telegram id their private chat has. Undefined for a user with no
// Telegram identity.
export function findRuleAuthor(
  db: Db,
  userId: UserId,
): { readonly user: User; readonly telegramId: number } | undefined {
  const row = db
    .prepare<
      [string],
      { id: string; timezone: string; active_ledger_id: string | null; external_id: string }
    >(
      `SELECT u.id, u.timezone, u.active_ledger_id, i.external_id
         FROM users u JOIN auth_identities i ON i.user_id = u.id AND i.provider = 'telegram'
        WHERE u.id = ?`,
    )
    .get(userId);
  if (row === undefined) return undefined;
  return {
    user: {
      id: row.id as UserId,
      timezone: row.timezone,
      activeLedgerId: row.active_ledger_id as LedgerId | null,
    },
    telegramId: Number(row.external_id),
  };
}

function scheduleColumns(schedule: Schedule): {
  day: number | null;
  weekday: number | null;
  month: number | null;
} {
  switch (schedule.kind) {
    case 'monthly':
      return { day: schedule.day, weekday: null, month: null };
    case 'weekly':
      return { day: null, weekday: schedule.weekday, month: null };
    case 'yearly':
      return { day: schedule.day, weekday: null, month: schedule.month };
  }
}

function toSchedule(row: RuleRow): Schedule {
  if (row.schedule === 'monthly' && row.day !== null) return { kind: 'monthly', day: row.day };
  if (row.schedule === 'weekly' && row.weekday !== null) {
    return { kind: 'weekly', weekday: row.weekday };
  }
  if (row.schedule === 'yearly' && row.day !== null && row.month !== null) {
    return { kind: 'yearly', day: row.day, month: row.month };
  }
  throw new Error(`rule ${row.id} has an unknown schedule`);
}

function toRule(row: RuleRow): RecurringRule {
  return {
    id: row.id as RuleId,
    ledgerId: row.ledger_id as LedgerId | null,
    userId: row.user_id as UserId,
    kind: row.kind,
    mode: row.mode,
    template: toTemplate(row),
    sealedTemplate: toSealedTemplate(row),
    reminderText: row.reminder_text,
    schedule: toSchedule(row),
    nextDueOn: row.next_due_on as LocalDate,
    pausedAt: row.paused_at === null ? null : new Date(row.paused_at),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
  };
}

function ruleCurrency(id: string, code: string): CurrencyCode {
  const currency = toCurrencyCode(code);
  if (currency === undefined) throw new Error(`rule ${id} has an unknown currency`);
  return currency;
}

function toSealedTemplate(row: RuleRow): SealedRuleTemplate | null {
  if (row.sealed === null || row.currency === null) return null;
  return { currency: ruleCurrency(row.id, row.currency), sealed: row.sealed };
}

function toTemplate(row: RuleRow): RuleTemplate | null {
  if (row.amount_minor === null || row.description === null || row.currency === null) return null;
  const currency = ruleCurrency(row.id, row.currency);
  return {
    amountMinor: row.amount_minor,
    currency,
    description: row.description,
    categoryId: row.category_id as CategoryId | null,
  };
}
