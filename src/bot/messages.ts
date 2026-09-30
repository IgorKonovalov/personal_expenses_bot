import type { LedgerKind } from '../db/ledgers.js';
import type { CurrencyCode } from '../domain/currencies.js';
import { formatMoney, type Money } from '../domain/money.js';
import type { LocalDate } from '../domain/time.js';
import { timezoneByIana, type TimezoneSlug } from '../domain/timezones.js';
import { compareVersions } from '../domain/version.js';
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

interface CategoriesScreenView {
  readonly ledger: LedgerRef;
  readonly categories: readonly { readonly name: string }[];
  // A line about what just changed, above the list.
  readonly header?: Html | undefined;
}

interface SettingsScreenView {
  // The IANA zone in effect.
  readonly timezone: string;
  readonly ledger: LedgerRef & { readonly defaultCurrency: CurrencyCode };
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
  settings: '⚙️ Настройки',
  help: '❓ Помощь',
} as const;

// The timezone picker's city labels, one per entry of TIMEZONES.
const timezoneLabels: Record<TimezoneSlug, string> = {
  belgrade: 'Белград',
  podgorica: 'Подгорица',
  moscow: 'Москва',
  almaty: 'Алматы',
  kaliningrad: 'Калининград',
  samara: 'Самара',
  yekaterinburg: 'Екатеринбург',
  novosibirsk: 'Новосибирск',
  vladivostok: 'Владивосток',
  tbilisi: 'Тбилиси',
  yerevan: 'Ереван',
};

// `Белград (Europe/Belgrade)`; a zone typed through [Другой…] shows as its IANA name alone.
function timezoneName(iana: string): string {
  const entry = timezoneByIana(iana);
  return entry === undefined ? iana : `${timezoneLabels[entry.slug]} (${iana})`;
}

// `Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе`
function expenseLine(verb: string, { expense, ledger }: ExpenseView): Html {
  return html`${verb} «${ledgerName(ledger)}»: <b>${formatMoney(expense)}</b> — ${shownDescription(expense.description)}`;
}

// Telegram rejects messages over 4096 characters. The /changelog entries get at most this many
// UTF-16 units of HTML, counted with their separators; the rest of the 4096 holds the header and
// the truncation line. Markup counts too, so the visible text is shorter still.
const CHANGELOG_BUDGET = 3900;
const CHANGELOG_SEPARATOR = '\n\n';

// What's new, per release, keyed `X.Y.Z` (ADR-0013). The version in package.json needs an entry:
// messages.test.ts fails the gate otherwise. Bodies only; versionAnnouncement adds the envelope.
const versionAnnouncements: Readonly<Record<string, Html>> = {
  '0.5.0': html`Бот сообщает о новых версиях, а /changelog показывает, что изменилось.`,
  '0.4.0': html`Появились настройки: кнопка [⚙️ Настройки] в меню и команда /settings. Там можно выбрать часовой пояс из списка городов и валюту по умолчанию для новых трат. Уже записанные траты не меняются.`,
  '0.3.0': html`У каждой траты теперь есть категория. Бот подбирает её по прошлым тратам с тем же описанием, а кнопка [Категория] под подтверждением меняет её. /categories — добавить, переименовать или скрыть категории.`,
  '0.2.0': html`Появилось меню [📊 Сегодня] [❓ Помощь] и команда /help. Трату можно удалить кнопкой [Удалить] и вернуть кнопкой [Вернуть]. Если сумма неоднозначна, например «1.200 обед», бот предложит варианты кнопками.`,
  '0.1.0': html`Первая версия. Отправьте трату текстом, например «450 кофе» или «12,50 EUR такси», а /today покажет траты за сегодня.`,
};

export const messages = {
  menu,
  // Bot command menu registered with setMyCommands at boot.
  commands: [
    { command: 'today', description: 'Траты за сегодня' },
    { command: 'categories', description: 'Категории: добавить, переименовать, скрыть' },
    { command: 'settings', description: 'Часовой пояс и валюта' },
    { command: 'help', description: 'Как записать трату' },
    { command: 'changelog', description: 'Что нового в боте' },
  ],

  welcome: ({ timezone, currency }: { timezone: string; currency: CurrencyCode }): Html =>
    joinHtml(
      [
        html`Здравствуйте! Отправьте трату, например «450 кофе», и я её запишу. Итоги за сегодня: /today.`,
        html`Часовой пояс: ${timezoneName(timezone)}. Валюта: ${currency}. Изменить: /settings.`,
      ],
      '\n\n',
    ),
  genericError: html`Что-то пошло не так. Проверьте /today и отправьте ещё раз, если трата не записалась.`,
  help: joinHtml(
    [
      html`Чтобы записать трату, отправьте сумму и описание, например «450 кофе». Валюту можно указать после суммы: «12,50 EUR такси».`,
      html``,
      html`${menu.today} — траты за сегодня`,
      html`${menu.settings} — часовой пояс, валюта и категории`,
      html`${menu.help} — эта подсказка`,
      html`/changelog — что нового в боте`,
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

  // The /categories screen. Category names are user text: message text interpolates them only
  // through `html`, and button labels carry them raw.
  categoriesScreen: ({ ledger, categories, header }: CategoriesScreenView): Html => {
    const body = joinHtml(
      [html`<b>Категории «${ledgerName(ledger)}»</b>`, ...categories.map((c) => html`${c.name}`)],
      '\n',
    );
    return header === undefined ? body : joinHtml([header, body], '\n\n');
  },
  addCategoryButton: 'Добавить',
  renameCategoryButton: 'Переименовать',
  archiveCategoryButton: 'Скрыть',
  renamePicker: html`Какую категорию переименовать?`,
  archivePicker: html`Какую категорию скрыть? Её можно вернуть, добавив снова.`,
  addCategoryPrompt: html`Как назвать новую категорию? До 32 символов.`,
  renameCategoryPrompt: (name: string): Html => html`Новое название для «${name}»? До 32 символов.`,
  // Asked above the prompt again when an answer is refused; the flow stays pending.
  categoryNameRefused: {
    empty: html`Название не может быть пустым.`,
    tooLong: html`Название длиннее 32 символов.`,
    startsWithDigit: html`Название не может начинаться с цифры.`,
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    expenseShaped: html`Похоже на трату. Сейчас я жду название категории. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.`,
    duplicate: html`Такая категория уже есть.`,
    limit: html`Категорий уже 30. Скройте ненужную, чтобы добавить новую.`,
  },
  categoryAdded: (name: string): Html => html`Категория «${name}» добавлена.`,
  categoryRestored: (name: string): Html => html`Категория «${name}» снова в списке.`,
  categoryRenamed: (name: string): Html => html`Категория переименована: «${name}».`,
  categoryArchived: (name: string): Html =>
    html`Категория «${name}» скрыта. Чтобы вернуть её, добавьте её снова.`,
  categoryLimitToast: 'Категорий уже 30. Скройте ненужную, чтобы добавить новую.',
  fallbackCategoryToast: '«Другое» нельзя скрыть',
  categoryGoneToast: 'Категория не найдена',
  flowExpired: html`Время ответа истекло. Начните заново: /categories.`,
  nothingToCancel: html`Сейчас нечего отменять.`,
  staleScreen: 'Этот экран устарел. Откройте его заново.',
  cancelButton: 'Отмена',

  // The /settings hub.
  settingsScreen: ({ timezone, ledger }: SettingsScreenView): Html =>
    joinHtml(
      [
        html`<b>Настройки</b>`,
        html`Часовой пояс: ${timezoneName(timezone)}`,
        html`Валюта по умолчанию для новых трат в «${ledgerName(ledger)}»: ${ledger.defaultCurrency}`,
      ],
      '\n',
    ),
  timezoneButton: 'Часовой пояс',
  currencyButton: 'Валюта',
  settingsCategoriesButton: 'Категории',
  timezonePicker: (timezone: string): Html =>
    html`Выберите часовой пояс. Сейчас: ${timezoneName(timezone)}.`,
  cityButton: (slug: TimezoneSlug): string => timezoneLabels[slug],
  otherTimezoneButton: 'Другой…',
  timezonePrompt: (timezone: string): Html =>
    html`Сейчас: ${timezoneName(timezone)}. Отправьте название часового пояса, например Europe/Istanbul.`,
  // Asked above the prompt again when an answer is refused; the flow stays pending.
  timezoneRefused: {
    unknown: html`Такого часового пояса нет.`,
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    expenseShaped: html`Похоже на трату. Сейчас я жду часовой пояс. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.`,
  },
  timezoneChangedToast: 'Часовой пояс изменён',
  timezoneUnchanged: 'Этот часовой пояс уже выбран',
  // A new default never converts or re-labels expenses already recorded (ADR-0003).
  currencyPicker: ({ ledger }: Pick<SettingsScreenView, 'ledger'>): Html =>
    html`Валюта по умолчанию для новых трат в «${ledgerName(ledger)}». Сейчас: ${ledger.defaultCurrency}. Записанные траты не меняются.`,
  currencyChangedToast: 'Валюта изменена',
  currencyUnchanged: 'Эта валюта уже выбрана',
  currencyForbidden: (ledger: LedgerRef): string =>
    `Валюту «${ledgerName(ledger)}» может изменить только владелец`,

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

  versionAnnouncements,
  // The message the admin gets at boot on a new version.
  versionAnnouncement: (version: string, body: Html): Html =>
    joinHtml([html`🆕 Версия ${version}`, body, html`Все изменения: /changelog`], '\n\n'),
  // /changelog: newest version first, by number. Older entries past the budget are dropped
  // whole and the reply says so.
  changelog: (announcements: Readonly<Record<string, Html>>): Html => {
    const entries = Object.entries(announcements)
      .sort(([a], [b]) => compareVersions(b, a))
      .map(([version, body]) => joinHtml([html`<b>${version}</b>`, body], '\n'));
    const shown: Html[] = [];
    let used = 0;
    for (const entry of entries) {
      used += entry.length + CHANGELOG_SEPARATOR.length;
      if (used > CHANGELOG_BUDGET) break;
      shown.push(entry);
    }
    const parts = [html`<b>Что нового</b>`, ...shown];
    if (shown.length < entries.length) parts.push(html`Более ранние версии не поместились.`);
    return joinHtml(parts, CHANGELOG_SEPARATOR);
  },
} as const;
