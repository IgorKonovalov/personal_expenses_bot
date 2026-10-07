import { toCurrencyCode } from '../domain/currencies.js';
import type { Db } from './connection.js';
import type { Ledger, LedgerId } from './ledgers.js';

export type UserId = string & { readonly __brand: 'UserId' };

export interface User {
  readonly id: UserId;
  readonly timezone: string;
  readonly activeLedgerId: LedgerId | null;
}

interface UserRow {
  id: string;
  timezone: string;
  active_ledger_id: string | null;
}

export function findUserByIdentity(db: Db, provider: string, externalId: string): User | undefined {
  const row = db
    .prepare<[string, string], UserRow>(
      `SELECT u.id, u.timezone, u.active_ledger_id
         FROM auth_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = ? AND i.external_id = ?`,
    )
    .get(provider, externalId);
  return row === undefined ? undefined : toUser(row);
}

export function insertUser(db: Db, user: { id: UserId; timezone: string; createdAt: Date }): void {
  db.prepare<[string, string, string]>(
    'INSERT INTO users (id, timezone, created_at) VALUES (?, ?, ?)',
  ).run(user.id, user.timezone, user.createdAt.toISOString());
}

export function insertIdentity(
  db: Db,
  identity: { provider: string; externalId: string; userId: UserId },
): void {
  db.prepare<[string, string, string]>(
    'INSERT INTO auth_identities (provider, external_id, user_id) VALUES (?, ?, ?)',
  ).run(identity.provider, identity.externalId, identity.userId);
}

export function setActiveLedger(db: Db, userId: UserId, ledgerId: LedgerId): void {
  db.prepare<[string, string]>('UPDATE users SET active_ledger_id = ? WHERE id = ?').run(
    ledgerId,
    userId,
  );
}

// The admission state of the user behind an identity (ADR-0024); undefined when none matches.
export interface Admission {
  readonly userId: UserId;
  readonly admittedAt: Date | null;
  readonly blockedAt: Date | null;
}

export function findAdmissionByIdentity(
  db: Db,
  provider: string,
  externalId: string,
): Admission | undefined {
  const row = db
    .prepare<
      [string, string],
      { id: string; admitted_at: string | null; blocked_at: string | null }
    >(
      `SELECT u.id, u.admitted_at, u.blocked_at
         FROM auth_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = ? AND i.external_id = ?`,
    )
    .get(provider, externalId);
  if (row === undefined) return undefined;
  return {
    userId: row.id as UserId,
    admittedAt: row.admitted_at === null ? null : new Date(row.admitted_at),
    blockedAt: row.blocked_at === null ? null : new Date(row.blocked_at),
  };
}

// Sets `admitted_at` unless it is already set. Returns false when nothing was written.
export function admitUser(db: Db, userId: UserId, at: Date): boolean {
  return (
    db
      .prepare<[string, string]>(
        'UPDATE users SET admitted_at = ? WHERE id = ? AND admitted_at IS NULL',
      )
      .run(at.toISOString(), userId).changes > 0
  );
}

// Sets or clears `blocked_at`. Returns false when the user was already in that state.
export function setUserBlocked(db: Db, userId: UserId, at: Date | null): boolean {
  const sql =
    at === null
      ? 'UPDATE users SET blocked_at = NULL WHERE id = ? AND blocked_at IS NOT NULL'
      : 'UPDATE users SET blocked_at = ? WHERE id = ? AND blocked_at IS NULL';
  const params = at === null ? [userId] : [at.toISOString(), userId];
  return db.prepare(sql).run(...params).changes > 0;
}

// The admin's /stats counts (ADR-0024): no amounts, no descriptions.
export interface UsageCounts {
  // Admitted and not blocked.
  readonly admitted: number;
  // Users who created a live expense in any ledger since `since`.
  readonly active: number;
  // Live expenses created since `since`.
  readonly expenses: number;
}

export function countUsage(db: Db, since: Date): UsageCounts {
  const admitted =
    db
      .prepare<[], number>(
        'SELECT COUNT(*) FROM users WHERE admitted_at IS NOT NULL AND blocked_at IS NULL',
      )
      .pluck()
      .get() ?? 0;
  const recent = db
    .prepare<[string], { active: number; expenses: number }>(
      `SELECT COUNT(DISTINCT created_by) AS active, COUNT(*) AS expenses
         FROM expenses WHERE deleted_at IS NULL AND created_at >= ?`,
    )
    .get(since.toISOString());
  return { admitted, active: recent?.active ?? 0, expenses: recent?.expenses ?? 0 };
}

// Account deletion's tombstone (ADR-0024): the identity goes, so the Telegram id matches no one,
// and the row stays for the group expenses it authored, with admission and the active ledger
// cleared. Returns false when the user was already deleted.
export function tombstoneUser(db: Db, userId: UserId, at: Date): boolean {
  db.prepare<[string]>('DELETE FROM auth_identities WHERE user_id = ?').run(userId);
  return (
    db
      .prepare<[string, string]>(
        `UPDATE users SET deleted_at = ?, admitted_at = NULL, active_ledger_id = NULL
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(at.toISOString(), userId).changes > 0
  );
}

// Whether the user's account was deleted.
export function isUserDeleted(db: Db, userId: UserId): boolean {
  return (
    db
      .prepare<[string], number>('SELECT deleted_at IS NOT NULL FROM users WHERE id = ?')
      .pluck()
      .get(userId) === 1
  );
}

// Returns false when the user already has this timezone: nothing is written.
export function updateUserTimezone(db: Db, userId: UserId, timezone: string): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        'UPDATE users SET timezone = ? WHERE id = ? AND timezone <> ?',
      )
      .run(timezone, userId, timezone).changes > 0
  );
}

// The onboarding state (ADR-0028): when the setup check was sent (null: never), and whether
// the user switched tips off.
export interface Onboarding {
  readonly onboardedAt: Date | null;
  readonly tipsOff: boolean;
}

export function findOnboarding(db: Db, userId: UserId): Onboarding {
  const row = db
    .prepare<[string], { onboarded_at: string | null; tips_off: number }>(
      'SELECT onboarded_at, tips_off FROM users WHERE id = ?',
    )
    .get(userId);
  if (row === undefined) throw new Error(`user ${userId} does not exist`);
  return {
    onboardedAt: row.onboarded_at === null ? null : new Date(row.onboarded_at),
    tipsOff: row.tips_off === 1,
  };
}

// Sets `onboarded_at` unless it is already set. True when this call set it, so of two
// concurrent first contacts only one sends the setup check.
export function markOnboarded(db: Db, userId: UserId, at: Date): boolean {
  return (
    db
      .prepare<[string, string]>(
        'UPDATE users SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL',
      )
      .run(at.toISOString(), userId).changes > 0
  );
}

// Returns false when the switch was already in that state.
export function setTipsOff(db: Db, userId: UserId, off: boolean): boolean {
  return (
    db
      .prepare<[number, string, number]>(
        'UPDATE users SET tips_off = ? WHERE id = ? AND tips_off <> ?',
      )
      .run(off ? 1 : 0, userId, off ? 1 : 0).changes > 0
  );
}

// The tidy chat switch (ADR-0038): true deletes the user's private message once it has recorded
// an expense.
export function findTidyChat(db: Db, userId: UserId): boolean {
  const on = db
    .prepare<[string], number>('SELECT tidy_chat FROM users WHERE id = ?')
    .pluck()
    .get(userId);
  if (on === undefined) throw new Error(`user ${userId} does not exist`);
  return on === 1;
}

// Returns false when the switch was already in that state.
export function setTidyChat(db: Db, userId: UserId, on: boolean): boolean {
  return (
    db
      .prepare<[number, string, number]>(
        'UPDATE users SET tidy_chat = ? WHERE id = ? AND tidy_chat <> ?',
      )
      .run(on ? 1 : 0, userId, on ? 1 : 0).changes > 0
  );
}

// The summary push switches: `monthly` for the closed month or budget period, `weekly` for the
// closed week.
export type PushKind = 'monthly' | 'weekly';

const PUSH_COLUMN: Record<PushKind, string> = { monthly: 'monthly_push', weekly: 'weekly_push' };

export function findPushOn(db: Db, userId: UserId, kind: PushKind): boolean {
  const on = db
    .prepare<[string], number>(`SELECT ${PUSH_COLUMN[kind]} FROM users WHERE id = ?`)
    .pluck()
    .get(userId);
  if (on === undefined) throw new Error(`user ${userId} does not exist`);
  return on === 1;
}

// Returns false when the switch was already in that state.
export function setPushOn(db: Db, userId: UserId, kind: PushKind, on: boolean): boolean {
  const column = PUSH_COLUMN[kind];
  return (
    db
      .prepare<[number, string, number]>(
        `UPDATE users SET ${column} = ? WHERE id = ? AND ${column} <> ?`,
      )
      .run(on ? 1 : 0, userId, on ? 1 : 0).changes > 0
  );
}

// Marks the user behind a Telegram id unreachable: they blocked the bot (ADR-0043). Keeps the
// first instant. Returns false when nothing was written.
export function markUnreachable(db: Db, telegramId: number, at: Date): boolean {
  return (
    db
      .prepare<[string, string]>(
        `UPDATE users SET unreachable_at = ?
          WHERE unreachable_at IS NULL
            AND id = (SELECT user_id FROM auth_identities
                       WHERE provider = 'telegram' AND external_id = ?)`,
      )
      .run(at.toISOString(), String(telegramId)).changes > 0
  );
}

// Clears `unreachable_at` for the user behind a Telegram id: any private update from them says
// the chat is open again. One conditional UPDATE, a no-op for a reachable user. Returns false
// when nothing was written.
export function clearUnreachable(db: Db, telegramId: number): boolean {
  return (
    db
      .prepare<[string]>(
        `UPDATE users SET unreachable_at = NULL
          WHERE unreachable_at IS NOT NULL
            AND id = (SELECT user_id FROM auth_identities
                       WHERE provider = 'telegram' AND external_id = ?)`,
      )
      .run(String(telegramId)).changes > 0
  );
}

export function isUnreachable(db: Db, userId: UserId): boolean {
  return (
    db
      .prepare<[string], number>('SELECT unreachable_at IS NOT NULL FROM users WHERE id = ?')
      .pluck()
      .get(userId) === 1
  );
}

// A user with a summary push on, and the private chat it goes to.
export interface PushRecipient {
  readonly user: User;
  readonly telegramId: number;
  readonly monthly: boolean;
  readonly weekly: boolean;
}

// Every user with either push on who can still be written to: not blocked, not deleted, not
// unreachable, with a Telegram identity.
export function listPushRecipients(db: Db): PushRecipient[] {
  return listPushTargets(db).map((target) => target.recipient);
}

// A push recipient with what deciding their due pushes reads: the personal ledger and its
// budget's period start day.
export interface PushTarget {
  readonly recipient: PushRecipient;
  // Undefined when the user has no personal ledger.
  readonly ledger: Ledger | undefined;
  // 1 without a budget.
  readonly periodStartDay: number;
}

interface PushTargetRow extends UserRow {
  external_id: string;
  monthly_push: number;
  weekly_push: number;
  ledger_id: string | null;
  ledger_name: string | null;
  default_currency: string | null;
  ledger_timezone: string | null;
  period_start_day: number | null;
}

// listPushRecipients' users with their personal ledger and budget, in one query: a scheduler
// tick reads every recipient, so nothing here may cost a statement per user.
export function listPushTargets(db: Db): PushTarget[] {
  return db
    .prepare<[], PushTargetRow>(
      `SELECT u.id, u.timezone, u.active_ledger_id, i.external_id, u.monthly_push, u.weekly_push,
              l.id AS ledger_id, l.name AS ledger_name, l.default_currency,
              l.timezone AS ledger_timezone, b.period_start_day
         FROM users u
         JOIN auth_identities i ON i.user_id = u.id AND i.provider = 'telegram'
         LEFT JOIN ledgers l ON l.owner_user_id = u.id AND l.kind = 'personal'
         LEFT JOIN ledger_budgets b ON b.ledger_id = l.id
        WHERE (u.monthly_push = 1 OR u.weekly_push = 1)
          AND u.blocked_at IS NULL AND u.deleted_at IS NULL AND u.unreachable_at IS NULL
        ORDER BY u.id`,
    )
    .all()
    .map((row) => ({
      recipient: {
        user: toUser(row),
        telegramId: Number(row.external_id),
        monthly: row.monthly_push === 1,
        weekly: row.weekly_push === 1,
      },
      ledger: toPersonalLedger(row),
      periodStartDay: row.period_start_day ?? 1,
    }));
}

function toPersonalLedger(row: PushTargetRow): Ledger | undefined {
  if (row.ledger_id === null || row.ledger_name === null || row.default_currency === null) {
    return undefined;
  }
  const defaultCurrency = toCurrencyCode(row.default_currency);
  if (defaultCurrency === undefined) {
    throw new Error(`ledger ${row.ledger_id} has an unknown default currency`);
  }
  return {
    id: row.ledger_id as LedgerId,
    kind: 'personal',
    name: row.ledger_name,
    defaultCurrency,
    timezone: row.ledger_timezone,
  };
}

function toUser(row: UserRow): User {
  return {
    id: row.id as UserId,
    timezone: row.timezone,
    activeLedgerId: row.active_ledger_id as LedgerId | null,
  };
}
