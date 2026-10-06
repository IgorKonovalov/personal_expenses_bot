import { findCategory } from '../db/categories.js';
import type { Expense } from '../db/expenses.js';
import { findActiveLedger, findLedgerById, type Ledger } from '../db/ledgers.js';
import { findOnboarding, setTipsOff, type User } from '../db/users.js';
import { insertTipShown, listTipsShown } from '../db/userTips.js';
import { FALLBACK_PRESET } from '../domain/categoryPresets.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { localDateOf } from '../domain/time.js';
import { pickTip, TIPS, type TipContext, type TipKey, type TipTrigger } from '../domain/tips.js';
import { currentFlow } from './flowSessions.js';
import type { ServiceDeps } from './provisionUser.js';
import { resolveUserTimezone, type TimezoneDeps } from './settings.js';

// Contextual tips (ADR-0028). A handler that just replied offers its trigger; the first registry
// entry whose condition holds and which the user hasn't seen is recorded, then sent. Nothing is
// offered when tips are off, the user isn't onboarded yet, a tip was already shown on the user's
// local today, a text flow is pending, or the chat isn't private. Recording before the send
// means a redelivered update never sends a tip twice, and a failed send loses it.

type TipDeps = Pick<ServiceDeps, 'db'> & TimezoneDeps;

export interface TipInput {
  readonly user: User;
  readonly trigger: TipTrigger;
  readonly privateChat: boolean;
  // For `expenseRecorded`: the expense just recorded, opened.
  readonly expense?: Expense;
  readonly now: Date;
}

// What a tip's copy may name: currency codes only, never amounts or descriptions.
export interface TipView {
  readonly ledgerCurrency: CurrencyCode;
  readonly expenseCurrency?: CurrencyCode;
}

export interface TipOffer {
  readonly key: TipKey;
  readonly view: TipView;
}

export function takeTip(deps: TipDeps, input: TipInput): TipOffer | undefined {
  if (!input.privateChat) return undefined;
  const { db } = deps;
  const { user, now } = input;
  return db.transaction((): TipOffer | undefined => {
    const onboarding = findOnboarding(db, user.id);
    if (onboarding.tipsOff || onboarding.onboardedAt === null) return undefined;
    if (currentFlow(deps, user, now) !== undefined) return undefined;
    const shown = listTipsShown(db, user.id);
    const timezone = resolveUserTimezone(deps, user);
    const today = localDateOf(now, timezone);
    if (shown.some((tip) => localDateOf(tip.shownAt, timezone) === today)) return undefined;
    const ledger = tipLedger(deps, user, input.expense);
    if (ledger === undefined) return undefined;
    const ctx = tipContext(deps, ledger, input.expense);
    const key = pickTip(TIPS, input.trigger, ctx, new Set(shown.map((tip) => tip.tip)));
    if (key === undefined || !insertTipShown(db, user.id, key, now)) return undefined;
    return {
      key,
      view: {
        ledgerCurrency: ledger.defaultCurrency,
        ...(input.expense === undefined ? {} : { expenseCurrency: input.expense.currency }),
      },
    };
  })();
}

// Whether the user gets tips: the settings hub's row.
export function tipsOn({ db }: Pick<ServiceDeps, 'db'>, user: User): boolean {
  return !findOnboarding(db, user.id).tipsOff;
}

// Returns false when tips were already in that state.
export function switchTips({ db }: Pick<ServiceDeps, 'db'>, user: User, on: boolean): boolean {
  return setTipsOff(db, user.id, !on);
}

// The expense's ledger, else the active one.
function tipLedger({ db }: TipDeps, user: User, expense: Expense | undefined): Ledger | undefined {
  return expense === undefined
    ? findActiveLedger(db, user.id)
    : findLedgerById(db, expense.ledgerId);
}

function tipContext({ db }: TipDeps, ledger: Ledger, expense: Expense | undefined): TipContext {
  return {
    ledgerCurrency: ledger.defaultCurrency,
    ...(expense === undefined
      ? {}
      : {
          expense: {
            currency: expense.currency,
            fallbackCategory:
              expense.category !== null &&
              findCategory(db, ledger.id, expense.category.id)?.presetKey === FALLBACK_PRESET,
          },
        }),
  };
}
