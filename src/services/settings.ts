import type { Db } from '../db/connection.js';
import {
  findActiveLedger,
  findLedgerById,
  findLedgerForMember,
  findMemberRole,
  updateLedgerCurrency,
  updateLedgerTimezone,
  type Ledger,
  type LedgerId,
} from '../db/ledgers.js';
import { findTidyChat, setTidyChat, updateUserTimezone, type User } from '../db/users.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { parseExpenseText } from '../domain/expenseText.js';
import { canonicalTimezone, resolveTimezone } from '../domain/timezones.js';
import type { Logger } from '../logger.js';
import { completeFlow, startFlow } from './flowSessions.js';
import type { ServiceDeps } from './provisionUser.js';

// The /settings use-cases: the user's timezone and the active ledger's default currency.
// DEFAULT_TIMEZONE is both the new-user default and the fallback for a stored zone this runtime
// doesn't know.

export interface TimezoneDeps {
  readonly logger: Logger;
  readonly defaultTimezone: string;
}

type SettingsDeps = ServiceDeps & TimezoneDeps;

// The zone every local date of this user is computed in. A stored value Intl rejects falls back
// to the default and logs a warn with the user id only.
export function resolveUserTimezone({ logger, defaultTimezone }: TimezoneDeps, user: User): string {
  const { tz, fellBack } = resolveTimezone(user.timezone, defaultTimezone);
  if (fellBack) logger.warn({ userId: user.id }, 'stored timezone is invalid, using the default');
  return tz;
}

export interface SettingsView {
  // The zone in effect, after the fallback.
  readonly timezone: string;
  readonly ledger: Ledger;
}

export function userSettings(deps: SettingsDeps, user: User): SettingsView {
  const ledger = findActiveLedger(deps.db, user.id);
  if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
  return { timezone: resolveUserTimezone(deps, user), ledger };
}

// A shared ledger the user owns, for the settings screen scoped to it: the ledger's own zone
// (ADR-0015) and currency. Undefined for a personal ledger, or anyone but the owner.
export function ledgerSettings(
  deps: SettingsDeps,
  user: User,
  ledgerId: LedgerId,
): SettingsView | undefined {
  const ledger = ownedSharedLedger(deps.db, user, ledgerId);
  if (ledger === undefined || ledger.timezone === null) return undefined;
  const { tz, fellBack } = resolveTimezone(ledger.timezone, deps.defaultTimezone);
  if (fellBack) {
    deps.logger.warn(
      { ledgerId: ledger.id },
      'stored ledger timezone is invalid, using the default',
    );
  }
  return { timezone: tz, ledger };
}

// The settings a screen shows: the ledger it is scoped to, else the user's own.
export function screenSettings(
  deps: SettingsDeps,
  user: User,
  ledgerId: LedgerId | undefined,
): SettingsView | undefined {
  return ledgerId === undefined ? userSettings(deps, user) : ledgerSettings(deps, user, ledgerId);
}

function ownedSharedLedger(db: Db, user: User, ledgerId: LedgerId): Ledger | undefined {
  const ledger = findLedgerForMember(db, ledgerId, user.id);
  if (ledger?.kind !== 'shared') return undefined;
  return findMemberRole(db, ledgerId, user.id) === 'owner' ? ledger : undefined;
}

// The settings hub's tidy chat row (ADR-0038).
export function tidyChatOn({ db }: Pick<ServiceDeps, 'db'>, user: User): boolean {
  return findTidyChat(db, user.id);
}

// Returns false when the switch was already in that state.
export function switchTidyChat({ db }: Pick<ServiceDeps, 'db'>, user: User, on: boolean): boolean {
  return setTidyChat(db, user.id, on);
}

export type LedgerTimezoneResult = { readonly kind: 'updated' | 'unchanged' | 'forbidden' };

// Sets a shared ledger's zone, for its owner. The owner's own zone is untouched, and rows
// recorded earlier keep their occurred_on (ADR-0015).
export function setLedgerTimezone(
  deps: SettingsDeps,
  input: { readonly user: User; readonly ledgerId: LedgerId; readonly timezone: string },
): LedgerTimezoneResult {
  const { db, logger } = deps;
  if (ownedSharedLedger(db, input.user, input.ledgerId) === undefined) return { kind: 'forbidden' };
  if (!updateLedgerTimezone(db, input.ledgerId, input.timezone)) return { kind: 'unchanged' };
  logger.info({ ledgerId: input.ledgerId, userId: input.user.id }, 'ledger timezone changed');
  return { kind: 'updated' };
}

// Stores a zone from the picker. `unchanged` when it is already the stored one: nothing written.
export function updateTimezone(
  deps: SettingsDeps,
  input: { readonly user: User; readonly timezone: string },
): { readonly kind: 'updated' | 'unchanged' } {
  if (!updateUserTimezone(deps.db, input.user.id, input.timezone)) return { kind: 'unchanged' };
  deps.logger.info({ userId: input.user.id }, 'timezone changed');
  return { kind: 'updated' };
}

// The [Другой…] prompt: for the user's own zone, or for the shared ledger `ledgerId`.
export function startTimezoneFlow(
  deps: SettingsDeps,
  user: User,
  now: Date,
  ledgerId?: LedgerId,
): void {
  startFlow(
    deps,
    user,
    ledgerId === undefined ? { kind: 'setTimezone' } : { kind: 'setTimezone', ledgerId },
    now,
  );
}

export type TimezoneRefusal = 'unknown' | 'expenseShaped';

export type TimezoneAnswerResult =
  | { readonly kind: 'updated'; readonly timezone: string }
  // The flow stays pending and the prompt is asked again.
  | { readonly kind: 'invalid'; readonly reason: TimezoneRefusal }
  // The user no longer owns the flow's ledger: the flow is answered, nothing written.
  | { readonly kind: 'forbidden' };

// A typed IANA name, stored in its canonical spelling: the user's zone, or the flow's ledger's.
// The write and the flow's completion commit together, keyed by `inputKey`, so a redelivered
// answer finds the flow already answered.
export function answerTimezoneFlow(
  deps: SettingsDeps,
  input: {
    readonly user: User;
    readonly text: string;
    readonly inputKey: string;
    readonly ledgerId?: LedgerId | undefined;
  },
): TimezoneAnswerResult {
  const { db } = deps;
  const { user, ledgerId } = input;
  return db.transaction((): TimezoneAnswerResult => {
    const timezone = canonicalTimezone(input.text);
    if (timezone === undefined) {
      const ledger =
        ledgerId === undefined ? findActiveLedger(db, user.id) : findLedgerById(db, ledgerId);
      const asExpense =
        ledger === undefined
          ? undefined
          : parseExpenseText(input.text, ledger.defaultCurrency).kind;
      return {
        kind: 'invalid',
        reason: asExpense === 'expense' || asExpense === 'ambiguous' ? 'expenseShaped' : 'unknown',
      };
    }
    completeFlow(deps, user, input.inputKey);
    if (ledgerId === undefined) {
      updateTimezone(deps, { user, timezone });
    } else if (setLedgerTimezone(deps, { user, ledgerId, timezone }).kind === 'forbidden') {
      return { kind: 'forbidden' };
    }
    return { kind: 'updated', timezone };
  })();
}

export type CurrencyResult =
  | { readonly kind: 'updated' | 'unchanged'; readonly ledger: Ledger }
  // Only the ledger's owner changes its currency.
  | { readonly kind: 'forbidden'; readonly ledger: Ledger };

// Sets the default currency of the active ledger, or of `ledgerId` from a ledger-scoped screen.
// It applies to expenses recorded afterwards; stored rows keep theirs (ADR-0003).
export function setLedgerCurrency(
  deps: SettingsDeps,
  input: {
    readonly user: User;
    readonly currency: CurrencyCode;
    readonly ledgerId?: LedgerId | undefined;
  },
): CurrencyResult {
  const { db, logger } = deps;
  const { user, currency } = input;
  return db.transaction((): CurrencyResult => {
    const ledger =
      input.ledgerId === undefined
        ? findActiveLedger(db, user.id)
        : findLedgerForMember(db, input.ledgerId, user.id);
    if (ledger === undefined) throw new Error(`user ${user.id} has no such ledger`);
    if (findMemberRole(db, ledger.id, user.id) !== 'owner') return { kind: 'forbidden', ledger };
    if (!updateLedgerCurrency(db, ledger.id, currency)) return { kind: 'unchanged', ledger };
    logger.info({ ledgerId: ledger.id, userId: user.id }, 'ledger currency changed');
    return { kind: 'updated', ledger: { ...ledger, defaultCurrency: currency } };
  })();
}
