import type { LedgerKind } from '../db/ledgers.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { formatMoney, type Money } from '../domain/money.js';
import type { LocalDate } from '../domain/time.js';

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

interface TodayView {
  readonly ledger: LedgerRef;
  readonly date: LocalDate;
  readonly totals: ReadonlyMap<CurrencyCode, number>;
}

// `2026-09-30` -> `30 сентября`. The date is already local, so it is formatted in UTC.
const dayMonth = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' });

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

// Telegram rejects messages over 4096 characters, and a description can be almost that long.
// Replies show at most this many code points of it; the stored description is untouched.
const MAX_SHOWN_DESCRIPTION = 200;

function shownDescription(description: string): string {
  const codePoints = Array.from(description);
  return codePoints.length <= MAX_SHOWN_DESCRIPTION
    ? description
    : `${codePoints.slice(0, MAX_SHOWN_DESCRIPTION).join('')}…`;
}

// Reply-keyboard labels. A text equal to a label is a menu tap, so no label may parse as an
// expense (bot.test.ts pins this).
const menu = {
  today: '📊 Сегодня',
  help: '❓ Помощь',
} as const;

export const messages = {
  menu,
  // Bot command menu registered with setMyCommands at boot.
  commands: [
    { command: 'today', description: 'Траты за сегодня' },
    { command: 'help', description: 'Как записать трату' },
  ],

  welcome:
    'Здравствуйте! Отправьте трату, например «450 кофе», и я её запишу. ' +
    'Итоги за сегодня: /today.',
  genericError:
    'Что-то пошло не так. Проверьте /today и отправьте ещё раз, если трата не записалась.',
  help:
    'Чтобы записать трату, отправьте сумму и описание, например «450 кофе». ' +
    'Валюту можно указать после суммы: «12,50 EUR такси».\n\n' +
    `${menu.today} — траты за сегодня\n` +
    `${menu.help} — эта подсказка`,
  editedMessageHint:
    'Изменение сообщения не меняет запись. ' +
    'Удалите трату кнопкой под подтверждением и отправьте её заново.',
  invalidAmount:
    'Не удалось разобрать сумму. Отправьте, например, «450 кофе» или «12,50 EUR такси». ' +
    'Тысячи отделяйте пробелом: «1 200 обед».',

  expenseRecorded: ({ expense, ledger }: ExpenseView) =>
    `Записано в «${ledgerName(ledger)}»: ${formatMoney(expense)} — ${shownDescription(expense.description)}`,
  undoButton: 'Отменить',

  ambiguousAmount: ({ readings, description, currency, defaultCurrency }: AmbiguousView) => {
    const code = currency === defaultCurrency ? '' : ` ${currency}`;
    const shown = readings.map(formatMoney).join(' или ');
    const resend = readings
      .map((r) => `«${retypeable(r)}${code} ${shownDescription(description)}»`)
      .join(' или ');
    // One reading when the other is invalid for the currency: `1.234` RSD, `1.200` JPY.
    const question =
      readings.length === 1
        ? `Уточните сумму: вы имели в виду ${shown}?`
        : `Сумму можно понять по-разному: ${shown}.`;
    return `${question} Ничего не записано. Отправьте ещё раз так: ${resend}.`;
  },

  expenseUndone: ({ expense, ledger }: ExpenseView) =>
    `Отменено в «${ledgerName(ledger)}»: ${formatMoney(expense)} — ${shownDescription(expense.description)}`,
  undoneToast: 'Трата отменена',
  alreadyUndone: 'Эта трата уже отменена',
  undoForbidden: 'Отменить трату может только тот, кто её записал',
  expenseNotFound: 'Трата не найдена',

  today: ({ ledger, date, totals }: TodayView) => {
    const header = `Сегодня, ${dayMonth.format(new Date(`${date}T00:00:00Z`))} — «${ledgerName(ledger)}»`;
    if (totals.size === 0) return `${header}\nТрат нет. Отправьте, например, «450 кофе».`;
    const lines = [...totals].map(([currency, amountMinor]) =>
      formatMoney({ amountMinor, currency }),
    );
    return [header, ...lines].join('\n');
  },
} as const;
