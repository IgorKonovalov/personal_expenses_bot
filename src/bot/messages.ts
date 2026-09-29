import type { LedgerKind } from '../db/ledgers.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { formatMoney, type Money } from '../domain/money.js';

// Every user-facing string, in Russian with polite "вы". Handlers pick a message here and never
// build copy themselves. Amounts are rendered only through formatMoney.

interface LedgerRef {
  readonly kind: LedgerKind;
  readonly name: string;
}

interface ExpenseView {
  readonly expense: Money & { readonly description: string };
  readonly ledger: LedgerRef;
}

interface AmbiguousView {
  readonly readings: readonly Money[];
  readonly description: string;
  // Named in the resend example only when it differs from the ledger default.
  readonly currency: CurrencyCode;
  readonly defaultCurrency: CurrencyCode;
}

function ledgerName(ledger: LedgerRef): string {
  return ledger.kind === 'personal' ? 'Личные расходы' : ledger.name;
}

// `1 200.00 RSD` -> `1200`, `1.20 RSD` -> `1.2`: the amount as the user should retype it so
// that it parses unambiguously.
function retypeable(money: Money): string {
  return formatMoney(money)
    .replace(/ [A-Z]{3}$/, '')
    .replaceAll(' ', '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

export const messages = {
  welcome: 'Здравствуйте! Отправьте трату, например «450 кофе», и я её запишу.',
  genericError: 'Что-то пошло не так. Попробуйте ещё раз.',
  help:
    'Чтобы записать трату, отправьте сумму и описание, например «450 кофе». ' +
    'Валюту можно указать после суммы: «12,50 EUR такси».',
  invalidAmount:
    'Не удалось разобрать сумму. Отправьте, например, «450 кофе» или «12,50 EUR такси». ' +
    'Тысячи отделяйте пробелом: «1 200 обед».',

  expenseRecorded: ({ expense, ledger }: ExpenseView) =>
    `Записано в «${ledgerName(ledger)}»: ${formatMoney(expense)} — ${expense.description}`,
  undoButton: 'Отменить',

  ambiguousAmount: ({ readings, description, currency, defaultCurrency }: AmbiguousView) => {
    const code = currency === defaultCurrency ? '' : ` ${currency}`;
    const shown = readings.map(formatMoney).join(' или ');
    const resend = readings.map((r) => `«${retypeable(r)}${code} ${description}»`).join(' или ');
    return `Сумму можно понять по-разному: ${shown}. Ничего не записано. Отправьте ещё раз так: ${resend}.`;
  },

  expenseUndone: ({ expense, ledger }: ExpenseView) =>
    `Отменено в «${ledgerName(ledger)}»: ${formatMoney(expense)} — ${expense.description}`,
  undoneToast: 'Трата отменена',
  alreadyUndone: 'Эта трата уже отменена',
  undoForbidden: 'Отменить трату может только тот, кто её записал',
  expenseNotFound: 'Трата не найдена',
} as const;
