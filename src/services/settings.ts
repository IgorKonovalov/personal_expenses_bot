import {
  findActiveLedger,
  findMemberRole,
  updateLedgerCurrency,
  type Ledger,
} from '../db/ledgers.js';
import { updateUserTimezone, type User } from '../db/users.js';
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

// Stores a zone from the picker. `unchanged` when it is already the stored one: nothing written.
export function updateTimezone(
  deps: SettingsDeps,
  input: { readonly user: User; readonly timezone: string },
): { readonly kind: 'updated' | 'unchanged' } {
  if (!updateUserTimezone(deps.db, input.user.id, input.timezone)) return { kind: 'unchanged' };
  deps.logger.info({ userId: input.user.id }, 'timezone changed');
  return { kind: 'updated' };
}

export function startTimezoneFlow(deps: SettingsDeps, user: User, now: Date): void {
  startFlow(deps, user, { kind: 'setTimezone' }, now);
}

export type TimezoneRefusal = 'unknown' | 'expenseShaped';

export type TimezoneAnswerResult =
  | { readonly kind: 'updated'; readonly timezone: string }
  // The flow stays pending and the prompt is asked again.
  | { readonly kind: 'invalid'; readonly reason: TimezoneRefusal };

// A typed IANA name, stored in its canonical spelling. The write and the flow's completion commit
// together, keyed by `inputKey`, so a redelivered answer finds the flow already answered.
export function answerTimezoneFlow(
  deps: SettingsDeps,
  input: { readonly user: User; readonly text: string; readonly inputKey: string },
): TimezoneAnswerResult {
  const { db } = deps;
  const { user } = input;
  return db.transaction((): TimezoneAnswerResult => {
    const timezone = canonicalTimezone(input.text);
    if (timezone === undefined) {
      const ledger = findActiveLedger(db, user.id);
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
    updateTimezone(deps, { user, timezone });
    return { kind: 'updated', timezone };
  })();
}

export type CurrencyResult =
  | { readonly kind: 'updated' | 'unchanged'; readonly ledger: Ledger }
  // Only the ledger's owner changes its currency.
  | { readonly kind: 'forbidden'; readonly ledger: Ledger };

// Sets the active ledger's default currency. It applies to expenses recorded afterwards; stored
// rows keep theirs (ADR-0003).
export function setLedgerCurrency(
  deps: SettingsDeps,
  input: { readonly user: User; readonly currency: CurrencyCode },
): CurrencyResult {
  const { db, logger } = deps;
  const { user, currency } = input;
  return db.transaction((): CurrencyResult => {
    const ledger = findActiveLedger(db, user.id);
    if (ledger === undefined) throw new Error(`user ${user.id} has no active ledger`);
    if (findMemberRole(db, ledger.id, user.id) !== 'owner') return { kind: 'forbidden', ledger };
    if (!updateLedgerCurrency(db, ledger.id, currency)) return { kind: 'unchanged', ledger };
    logger.info({ ledgerId: ledger.id, userId: user.id }, 'ledger currency changed');
    return { kind: 'updated', ledger: { ...ledger, defaultCurrency: currency } };
  })();
}
