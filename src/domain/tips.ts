import type { CurrencyCode } from './currencies.js';

// The contextual tips registry (ADR-0028): one entry per tip, in priority order. A trigger is a
// moment a handler just replied; a condition is pure over the context the service assembles. A
// tip's copy lives in the messages module under the same key.

export type TipTrigger = 'expenseRecorded' | 'todayShown' | 'monthShown' | 'settingsShown';

// The ledger is the expense's for `expenseRecorded`, the active one otherwise.
export interface TipContext {
  readonly ledgerKind: 'personal' | 'shared';
  readonly ledgerCurrency: CurrencyCode;
  // Present for `expenseRecorded`: the expense just recorded.
  readonly expense?: {
    readonly currency: CurrencyCode;
    // In the ledger's fallback category («Другое»).
    readonly fallbackCategory: boolean;
    readonly fromReceipt: boolean;
  };
  // The ledger's live expenses, every author's.
  readonly ledgerExpenseCount: number;
  // The ledger's budget has an overall limit.
  readonly hasBudgetLimit: boolean;
  readonly sealed: boolean;
  readonly ownsLedger: boolean;
}

// tipGroup counts a personal ledger's expenses, which are all the user's own.
const GROUP_TIP_EXPENSES = 20;
const EXPORT_TIP_EXPENSES = 50;

export interface TipEntry {
  readonly key: string;
  readonly trigger: TipTrigger;
  readonly condition: (ctx: TipContext) => boolean;
}

export const TIPS = [
  {
    key: 'tipOther',
    trigger: 'expenseRecorded',
    condition: (ctx) => ctx.expense?.fallbackCategory === true,
  },
  {
    key: 'tipForeign',
    trigger: 'expenseRecorded',
    condition: (ctx) => ctx.expense !== undefined && ctx.expense.currency !== ctx.ledgerCurrency,
  },
  {
    key: 'tipReceipt',
    trigger: 'expenseRecorded',
    condition: (ctx) => ctx.expense?.fromReceipt === true,
  },
  {
    key: 'tipGroup',
    trigger: 'expenseRecorded',
    condition: (ctx) =>
      ctx.ledgerKind === 'personal' && ctx.ledgerExpenseCount >= GROUP_TIP_EXPENSES,
  },
  {
    key: 'tipExport',
    trigger: 'expenseRecorded',
    condition: (ctx) => ctx.ledgerExpenseCount >= EXPORT_TIP_EXPENSES,
  },
  { key: 'tipFirstExpense', trigger: 'expenseRecorded', condition: () => true },
  { key: 'tipPastDate', trigger: 'todayShown', condition: () => true },
  { key: 'tipBudget', trigger: 'monthShown', condition: (ctx) => !ctx.hasBudgetLimit },
  {
    key: 'tipEncrypt',
    trigger: 'settingsShown',
    condition: (ctx) => ctx.ledgerKind === 'personal' && ctx.ownsLedger && !ctx.sealed,
  },
] as const satisfies readonly TipEntry[];

export type TipKey = (typeof TIPS)[number]['key'];

export const TIP_KEYS: readonly TipKey[] = TIPS.map((tip) => tip.key);

export function isTipKey(key: string): key is TipKey {
  return (TIP_KEYS as readonly string[]).includes(key);
}

// The first entry for the trigger whose condition holds and whose key the user hasn't seen.
export function pickTip<K extends string>(
  registry: readonly (TipEntry & { readonly key: K })[],
  trigger: TipTrigger,
  ctx: TipContext,
  seen: ReadonlySet<string>,
): K | undefined {
  return registry.find((tip) => tip.trigger === trigger && !seen.has(tip.key) && tip.condition(ctx))
    ?.key;
}
