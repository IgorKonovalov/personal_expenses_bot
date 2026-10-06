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

export interface RecurringRule {
  readonly id: RuleId;
  // NULL for a reminder.
  readonly ledgerId: LedgerId | null;
  readonly userId: UserId;
  readonly kind: RuleKind;
  readonly mode: RuleMode;
  // A plaintext expense rule's template; NULL for a reminder.
  readonly template: RuleTemplate | null;
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
  category_id, reminder_text, schedule, day, weekday, month, next_due_on, paused_at, deleted_at`;

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
                                  description, category_id, reminder_text, schedule, day,
                                  weekday, month, next_due_on, source_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rule.id,
    rule.ledgerId,
    rule.userId,
    rule.kind,
    rule.mode,
    rule.template?.amountMinor ?? null,
    rule.template?.currency ?? null,
    rule.template?.description ?? null,
    rule.template?.categoryId ?? null,
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
  return { day: schedule.day, weekday: null, month: null };
}

function toSchedule(row: RuleRow): Schedule {
  if (row.schedule === 'monthly' && row.day !== null) return { kind: 'monthly', day: row.day };
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
    reminderText: row.reminder_text,
    schedule: toSchedule(row),
    nextDueOn: row.next_due_on as LocalDate,
    pausedAt: row.paused_at === null ? null : new Date(row.paused_at),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
  };
}

function toTemplate(row: RuleRow): RuleTemplate | null {
  if (row.amount_minor === null || row.description === null || row.currency === null) return null;
  const currency = toCurrencyCode(row.currency);
  if (currency === undefined) throw new Error(`rule ${row.id} has an unknown currency`);
  return {
    amountMinor: row.amount_minor,
    currency,
    description: row.description,
    categoryId: row.category_id as CategoryId | null,
  };
}
