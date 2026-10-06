import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { countLiveExpenses } from '../db/expenses.js';
import { findActiveLedger } from '../db/ledgers.js';
import {
  findOnboarding,
  findUserByIdentity,
  markOnboarded,
  setTipsOff,
  type User,
} from '../db/users.js';
import { deleteUserTips } from '../db/userTips.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { userSettings, type TimezoneDeps } from './settings.js';
import type { ServiceDeps } from './provisionUser.js';

// First contact (ADR-0028): a user counts as onboarded once the setup check is sent, so a user
// who ignores it isn't asked again. /start replays the tour: the tips start over and switch on.
// One-time notices (ADR-0037) are never replayed.

type OnboardingDeps = ServiceDeps & TimezoneDeps;

export interface SetupView {
  // The zone in effect, after the fallback.
  readonly timezone: string;
  readonly currency: CurrencyCode;
}

export interface SetupCheckView extends SetupView {
  // `HH:MM` now, in `timezone`.
  readonly localTime: string;
}

// The user behind a Telegram account who has never been onboarded; undefined for an onboarded,
// deleted or never-provisioned one. Provisions nothing.
export function pendingOnboarding(
  { db }: Pick<ServiceDeps, 'db'>,
  telegramId: number,
): User | undefined {
  const user = findUserByIdentity(db, 'telegram', String(telegramId));
  return user === undefined || findOnboarding(db, user.id).onboardedAt !== null ? undefined : user;
}

// Whether the user has a live expense of their own in the active ledger: on first contact, the
// message just handled recorded it.
export function hasOwnExpense({ db }: Pick<ServiceDeps, 'db'>, user: User): boolean {
  const ledger = findActiveLedger(db, user.id);
  return ledger !== undefined && countLiveExpenses(db, ledger.id, user.id) > 0;
}

export function isOnboarded({ db }: Pick<ServiceDeps, 'db'>, user: User): boolean {
  return findOnboarding(db, user.id).onboardedAt !== null;
}

// Marks the user onboarded. True when this call did, so the caller sends the setup check; false
// when an earlier update (a redelivery, a concurrent message) already had.
export function claimOnboarding({ db }: Pick<ServiceDeps, 'db'>, user: User, now: Date): boolean {
  return markOnboarded(db, user.id, now);
}

// /start from an onboarded user: every tip may show again, and tips are on.
export function replayOnboarding({ db }: Pick<ServiceDeps, 'db'>, user: User): void {
  db.transaction(() => {
    deleteUserTips(db, user.id);
    setTipsOff(db, user.id, false);
  })();
}

// The user's timezone and the active ledger's default currency.
export function setupView(deps: OnboardingDeps, user: User): SetupView {
  const { timezone, ledger } = userSettings(deps, user);
  return { timezone, currency: ledger.defaultCurrency };
}

export function setupCheckView(deps: OnboardingDeps, user: User, now: Date): SetupCheckView {
  const view = setupView(deps, user);
  return { ...view, localTime: format(new TZDate(now.getTime(), view.timezone), 'HH:mm') };
}
