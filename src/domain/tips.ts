import type { CurrencyCode } from './currencies.js';

// The contextual tips registry (ADR-0028): one entry per tip, in priority order. A trigger is a
// moment a handler just replied; a condition is pure over the context the service assembles. A
// tip's copy lives in the messages module under the same key.

export type TipTrigger = 'expenseRecorded' | 'todayShown' | 'monthShown' | 'settingsShown';

export interface TipContext {
  readonly ledgerCurrency: CurrencyCode;
  // Present for `expenseRecorded`: the expense just recorded.
  readonly expense?: {
    readonly currency: CurrencyCode;
    // In the ledger's fallback category («Другое»).
    readonly fallbackCategory: boolean;
  };
}

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
  { key: 'tipFirstExpense', trigger: 'expenseRecorded', condition: () => true },
  { key: 'tipPastDate', trigger: 'todayShown', condition: () => true },
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
