import type { LedgerKind } from '../db/ledgers.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { formatMoney, type Money } from '../domain/money.js';
import type { LocalDate } from '../domain/time.js';
import { html, joinHtml, type Html } from './render/html.js';

// Every user-facing string, in Russian with polite "вы". Handlers pick a message here and never
// build copy themselves. Amounts are rendered only through formatMoney.
// Message texts are `Html` (ADR-0012); toasts, button labels and command descriptions stay plain
// strings because Telegram doesn't parse them.

interface LedgerRef {
  readonly kind: LedgerKind;
  readonly name: string;
}

interface ExpenseView {
  readonly expense: Money & {
    readonly description: string;
    readonly category: { readonly name: string } | null;
  };
  readonly ledger: LedgerRef;
}

interface AmbiguousView {
  readonly readings: readonly Money[];
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

// Telegram rejects messages over 4096 characters, and a description can be almost that long.
// Replies show at most this many code points of it; the stored description is untouched. The cut
// runs on raw text, before escaping, so it can never split an entity.
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

// `Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе`
function expenseLine(verb: string, { expense, ledger }: ExpenseView): Html {
  return html`${verb} «${ledgerName(ledger)}»: <b>${formatMoney(expense)}</b> — ${shownDescription(expense.description)}`;
}

export const messages = {
  menu,
  // Bot command menu registered with setMyCommands at boot.
  commands: [
    { command: 'today', description: 'Траты за сегодня' },
    { command: 'help', description: 'Как записать трату' },
  ],

  welcome: html`Здравствуйте! Отправьте трату, например «450 кофе», и я её запишу. Итоги за сегодня: /today.`,
  genericError: html`Что-то пошло не так. Проверьте /today и отправьте ещё раз, если трата не записалась.`,
  help: joinHtml(
    [
      html`Чтобы записать трату, отправьте сумму и описание, например «450 кофе». Валюту можно указать после суммы: «12,50 EUR такси».`,
      html``,
      html`${menu.today} — траты за сегодня`,
      html`${menu.help} — эта подсказка`,
    ],
    '\n',
  ),
  editedMessageHint: html`Изменение сообщения не меняет запись. Удалите трату кнопкой под подтверждением и отправьте её заново.`,
  invalidAmount: html`Не удалось разобрать сумму. Отправьте, например, «450 кофе» или «12,50 EUR такси». Тысячи отделяйте пробелом: «1 200 обед».`,

  // `… — кофе · Кафе и рестораны`. An expense from before categories existed has none to show.
  expenseRecorded: (view: ExpenseView): Html => {
    const line = expenseLine('Записано в', view);
    const { category } = view.expense;
    return category === null ? line : joinHtml([line, html`${category.name}`], ' · ');
  },
  // «Отменить» is never a label: it would read like the flows' «Отмена» (ADR-0011).
  undoButton: 'Удалить',

  // Asked with one button per reading. One reading when the other is invalid for the currency:
  // `1.234` RSD, `1.200` JPY.
  ambiguousAmount: ({ readings }: AmbiguousView): Html => {
    const [only] = readings;
    return readings.length === 1 && only !== undefined
      ? html`Ничего не записано. Вы имели в виду ${formatMoney(only)}?`
      : html`Сумму можно понять по-разному. Ничего не записано — выберите:`;
  },
  // The button label is the exact amount that a tap stores.
  readingButton: (reading: Money): string => formatMoney(reading),
  ambiguousSourceUnavailable: 'Исходное сообщение недоступно. Отправьте трату ещё раз.',

  expenseUndone: (view: ExpenseView) => expenseLine('Удалено из', view),
  undoneToast: 'Трата удалена',
  alreadyUndone: 'Эта трата уже удалена',
  undoForbidden: 'Удалить трату может только тот, кто её записал',
  restoreButton: 'Вернуть',
  restoredToast: 'Трата восстановлена',
  alreadyRestored: 'Трата уже восстановлена',
  restoreForbidden: 'Вернуть трату может только тот, кто её записал',
  expenseNotFound: 'Трата не найдена',

  // The category picker, edited into the card (ADR-0011).
  categoryButton: 'Категория',
  categoryPicker: (view: ExpenseView): Html =>
    joinHtml([expenseLine('Записано в', view), html`Выберите категорию:`], '\n'),
  categoryChangedToast: 'Категория изменена',
  categoryUnchanged: 'Эта категория уже выбрана',
  categoryForbidden: 'Изменить категорию может только тот, кто записал трату',
  categoryUnavailable: 'Эта категория недоступна',
  expenseDeletedToast: 'Трата удалена. Сначала верните её.',

  // Navigation kit (ADR-0011). «Назад» is never a pager label.
  backButton: '« Назад',
  pagerPrev: '◀',
  pagerNext: '▶',
  pagerPosition: (page: number, pageCount: number): string => `${page}/${pageCount}`,
  // The current value in a picker.
  currentChoice: (label: string): string => `✓ ${label}`,

  today: ({ ledger, date, totals }: TodayView): Html => {
    const header = html`<b>Сегодня, ${dayMonth.format(new Date(`${date}T00:00:00Z`))} — «${ledgerName(ledger)}»</b>`;
    if (totals.size === 0) {
      return joinHtml([header, html`Трат нет. Отправьте, например, «450 кофе».`], '\n');
    }
    const lines = [...totals].map(
      ([currency, amountMinor]) => html`${formatMoney({ amountMinor, currency })}`,
    );
    return joinHtml([header, ...lines], '\n');
  },
} as const;
