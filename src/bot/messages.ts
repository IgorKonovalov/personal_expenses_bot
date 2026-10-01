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

// What's left of a ledger's budget, under a recorded card. Negative amounts are overspend.
interface BudgetLineView {
  readonly currency: CurrencyCode;
  readonly todayLeftMinor: number;
  readonly periodLeftMinor: number;
  // The period's last day.
  readonly to: LocalDate;
}

interface RecordedView extends ExpenseView {
  readonly expense: ExpenseView['expense'] & { readonly occurredOn: LocalDate };
  // The author's local date when they sent it. An expense dated otherwise names its date.
  readonly sentOn: LocalDate;
  // Absent when the ledger has no overall limit.
  readonly budget?: BudgetLineView | undefined;
  // Absent when the expense's category has no cap.
  readonly cap?: (CapView & { readonly currency: CurrencyCode }) | undefined;
}

// A category's spend in the budget period against its cap.
interface CapView {
  readonly name: string;
  readonly spentMinor: number;
  readonly capMinor: number;
}

interface BudgetScreenView {
  readonly ledger: LedgerRef & { readonly defaultCurrency: CurrencyCode };
  readonly status?:
    | {
        readonly currency: CurrencyCode;
        readonly scope: 'all' | 'optional';
        readonly period: {
          readonly from: LocalDate;
          readonly to: LocalDate;
          readonly day: number;
          readonly days: number;
        };
        readonly limit?:
          | {
              readonly limitMinor: number;
              readonly spentMinor: number;
              readonly todayLeftMinor: number;
              readonly periodLeftMinor: number;
            }
          | undefined;
        readonly caps: readonly CapView[];
        readonly notCounted: ReadonlyMap<CurrencyCode, number>;
      }
    | undefined;
}

// A group expense: who recorded it (their Telegram first name, user text) and what.
interface GroupCardView {
  readonly author: string;
  readonly expense: RecordedView['expense'];
  readonly sentOn: LocalDate;
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

// A group report's per-person section: each member's totals, one per currency, never added
// together. `name` is the member's Telegram first name (user text), null when never stored.
type PeopleView = readonly {
  readonly name: string | null;
  readonly totals: readonly Money[];
}[];

interface TodayView {
  readonly ledger: LedgerRef;
  readonly date: LocalDate;
  readonly totals: ReadonlyMap<CurrencyCode, number>;
  readonly people?: PeopleView | undefined;
}

interface PeriodRef {
  readonly kind: 'week' | 'month';
  readonly from: LocalDate;
  readonly to: LocalDate;
}

interface SummaryView {
  readonly ledger: LedgerRef;
  readonly period: PeriodRef;
  readonly currencies: readonly {
    readonly currency: CurrencyCode;
    readonly totalMinor: number;
    // `name` null: the expenses without a category.
    readonly lines: readonly { readonly name: string | null; readonly amountMinor: number }[];
  }[];
  readonly people?: PeopleView | undefined;
}

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;
// Genitive abbreviations for the pager: `28 сен – 4 окт`.
const SHORT_MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const;
const GENITIVE_MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

function dateParts(date: LocalDate): { year: string; month: number; day: number } {
  return {
    year: date.slice(0, 4),
    month: Number(date.slice(5, 7)) - 1,
    day: Number(date.slice(8)),
  };
}

// `21–27 сентября`, or `28 сентября – 4 октября` across a month end.
function weekRange(
  { from, to }: Pick<PeriodRef, 'from' | 'to'>,
  months: readonly string[],
): string {
  const a = dateParts(from);
  const b = dateParts(to);
  return a.month === b.month
    ? `${a.day}–${b.day} ${months[b.month]}`
    : `${a.day} ${months[a.month]} – ${b.day} ${months[b.month]}`;
}

// The pager's name for a period: `Август`, `21–27 сен`, `28 сен – 4 окт`.
function periodLabel(period: PeriodRef): string {
  return period.kind === 'month'
    ? (MONTHS[dateParts(period.from).month] ?? '')
    : weekRange(period, SHORT_MONTHS);
}

// Telegram rejects a message over 4096 characters of visible text (ADR-0012): tags and
// entity escapes don't count.
const MAX_VISIBLE_CHARS = 4096;

function visibleLength(text: Html): number {
  return text.replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|amp|quot);/g, '_').length;
}

// `1 200.00 RSD` without the code, for a line under its currency's total.
function amountOnly(money: Money): string {
  return formatMoney(money).slice(0, -(money.currency.length + 1));
}

const noExpenses = html`Трат нет. Отправьте, например, «450 кофе».`;

// `Анна: 1 650.00 RSD, 12.50 EUR` per member, under a heading. Empty when nobody spent.
function peopleSection(people: PeopleView | undefined): Html[] {
  if (people === undefined || people.length === 0) return [];
  return [
    joinHtml(
      [
        html`<b>По участникам</b>`,
        ...people.map(
          (person) =>
            html`${person.name ?? 'Без имени'}: ${person.totals.map(formatMoney).join(', ')}`,
        ),
      ],
      '\n',
    ),
  ];
}

// `2026-09-30` -> `30 сентября`. The date is already local, so it is formatted in UTC.
const dayMonth = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function ledgerName(ledger: LedgerRef): string {
  return ledger.kind === 'personal' ? 'Личные расходы' : ledger.name;
}

// `31 окт`: a period's last day in the budget lines.
function shortDate(date: LocalDate): string {
  const { month, day } = dateParts(date);
  return `${day} ${SHORT_MONTHS[month] ?? ''}`;
}

// `Осталось на сегодня: 517.74 RUB` or `Сегодня перерасход 532.26 RUB`.
function todayLeft(amountMinor: number, currency: CurrencyCode): string {
  return amountMinor < 0
    ? `Сегодня перерасход ${formatMoney({ amountMinor: -amountMinor, currency })}`
    : `Осталось на сегодня: ${formatMoney({ amountMinor, currency })}`;
}

// `до 31 окт: 29 550.00 RUB` or `до 31 окт перерасход 1 000.00 RUB`.
function periodLeft(amountMinor: number, currency: CurrencyCode, to: LocalDate): string {
  return amountMinor < 0
    ? `до ${shortDate(to)} перерасход ${formatMoney({ amountMinor: -amountMinor, currency })}`
    : `до ${shortDate(to)}: ${formatMoney({ amountMinor, currency })}`;
}

// `Кафе и рестораны: 450.00 из 5 000.00 RSD`, or with `, перерасход 250.00 RSD` past the cap.
function capLine({ name, spentMinor, capMinor }: CapView, currency: CurrencyCode): Html {
  const line = html`${name}: ${amountOnly({ amountMinor: spentMinor, currency })} из ${formatMoney({ amountMinor: capMinor, currency })}`;
  return spentMinor > capMinor
    ? joinHtml(
        [line, html`перерасход ${formatMoney({ amountMinor: spentMinor - capMinor, currency })}`],
        ', ',
      )
    : line;
}

function budgetLine({ currency, todayLeftMinor, periodLeftMinor, to }: BudgetLineView): Html {
  return html`${todayLeft(todayLeftMinor, currency)} · ${periodLeft(periodLeftMinor, currency, to)}`;
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
  week: '📅 Неделя',
  month: '🗓 Месяц',
  budget: '💰 Бюджет',
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

// `2026-09-28` -> `28 сентября`, or `5 октября 2025` when the year differs from `sentOn`'s.
function shownDate(date: LocalDate, sentOn: LocalDate): string {
  const day = dayMonth.format(new Date(`${date}T00:00:00Z`));
  return date.slice(0, 4) === sentOn.slice(0, 4) ? day : `${day} ${date.slice(0, 4)}`;
}

// `Записано в «Личные расходы»: <b>450.00 RSD</b> — кофе`, or `… «Личные расходы» за 28
// сентября: …` with a date.
function expenseLine(verb: string, { expense, ledger }: ExpenseView, date?: string): Html {
  const when = date === undefined ? '' : ` за ${date}`;
  return html`${verb} «${ledgerName(ledger)}»${when}: <b>${formatMoney(expense)}</b> — ${shownDescription(expense.description)}`;
}

// `Ира: <b>2.00 RSD</b> — минуты буду`, or `Ира за 28 сентября: …` with a date.
function groupExpenseLine({ author, expense, sentOn }: GroupCardView): Html {
  const when = expense.occurredOn === sentOn ? '' : ` за ${shownDate(expense.occurredOn, sentOn)}`;
  return html`${author}${when}: <b>${formatMoney(expense)}</b> — ${shownDescription(expense.description)}`;
}

// Telegram rejects messages over 4096 characters. The /changelog entries get at most this many
// UTF-16 units of HTML, counted with their separators; the rest of the 4096 holds the header and
// the truncation line. Markup counts too, so the visible text is shorter still.
const CHANGELOG_BUDGET = 3900;
const CHANGELOG_SEPARATOR = '\n\n';

// What's new, per release, keyed `X.Y.Z` (ADR-0013). The version in package.json needs an entry:
// messages.test.ts fails the gate otherwise. Bodies only; versionAnnouncement adds the envelope.
const versionAnnouncements: Readonly<Record<string, Html>> = {
  '0.8.0': html`Появился бюджет: /budget или кнопка [💰 Бюджет]. Задайте лимит на период, и под каждой тратой будет видно, сколько осталось на сегодня и до конца периода. Период может начинаться в день зарплаты, обязательные категории можно не считать, а отдельным категориям — задать свой лимит. В группе /budget показывает бюджет общего учёта.`,
  '0.7.0': html`Бота можно добавить в группу, например семейную: у группы будет свой общий учёт. Любой участник пишет трату, например «450 кафе», и она записывается на его имя. /today, /week и /month в группе показывают траты по категориям и по участникам. Личные траты в группе не видны.`,
  '0.6.0': html`Трату можно записать задним числом: дата последним словом, например «450 такси вчера» или «450 такси 25.09». /week и /month, а также кнопки [📅 Неделя] и [🗓 Месяц] показывают траты по категориям. Кнопка [Изменить] под подтверждением меняет сумму, описание или дату.`,
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
    { command: 'week', description: 'Траты за неделю по категориям' },
    { command: 'month', description: 'Траты за месяц по категориям' },
    { command: 'budget', description: 'Бюджет: лимит и остаток на сегодня' },
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
  // Sent to a group once, when it is bound to a new shared ledger (ADR-0014).
  groupWelcome: ({ timezone, currency }: { timezone: string; currency: CurrencyCode }): Html =>
    joinHtml(
      [
        html`Здравствуйте! Я веду общие траты этой группы. Напишите сумму и описание, например «450 кафе», и я запишу трату на ваше имя.`,
        html`Личные траты из переписки со мной сюда не попадают.`,
        html`Часовой пояс: ${timezoneName(timezone)}. Валюта: ${currency}.`,
      ],
      '\n\n',
    ),
  // The reaction on a group expense whose category was recognised (ADR-0014). Bots may react
  // only with Telegram's standard emoji.
  groupRecordedReaction: '✍',
  // The group card, for an expense that fell through to «Другое», a reaction Telegram refused,
  // or a /card reply.
  groupExpenseCard: (view: GroupCardView): Html => {
    const { category } = view.expense;
    const line = groupExpenseLine(view);
    return category === null ? line : joinHtml([line, html`${category.name}`], ' · ');
  },
  groupExpenseDeleted: (view: GroupCardView): Html =>
    joinHtml([html`Удалено.`, groupExpenseLine(view)], ' '),
  // A deep link to the author's DM card, shown only to an allowlisted author (ADR-0014).
  groupEditInDmButton: 'Изменить в личке',
  groupNotAuthor: 'Это может только тот, кто записал трату',
  // The group's /settings, for the ledger's owner: the settings open in the DM.
  groupSettingsLink: html`Настройки группы — часовой пояс и валюта — открываются в личной переписке со мной.`,
  groupSettingsButton: 'Открыть настройки',
  groupSettingsOwnerOnly: html`Настройки группы может менять только тот, кто добавил меня в группу.`,
  genericError: html`Что-то пошло не так. Проверьте /today и отправьте ещё раз, если трата не записалась.`,
  help: joinHtml(
    [
      html`Чтобы записать трату, отправьте сумму и описание, например «450 кофе». Валюту можно указать после суммы: «12,50 EUR такси».`,
      html``,
      html`${menu.today} — траты за сегодня`,
      html`${menu.week} и ${menu.month} — траты по категориям`,
      html`${menu.budget} — лимит и сколько осталось на сегодня`,
      html`${menu.settings} — часовой пояс, валюта и категории`,
      html`${menu.help} — эта подсказка`,
      html`/changelog — что нового в боте`,
      html``,
      html`Общие траты семьи или компании: добавьте меня в группу. Там каждый записывает траты сам, а /month показывает итоги по категориям и по участникам. Личные траты отсюда в группу не попадают.`,
    ],
    '\n',
  ),
  // /help in a group: no menu keyboard, the group's own commands (ADR-0014).
  groupHelp: joinHtml(
    [
      html`Чтобы записать трату группы, напишите сумму и описание, например «450 кафе». Валюту можно указать после суммы: «12,50 EUR такси». Трата записывается на ваше имя; узнанную трату я отмечаю реакцией, остальные — карточкой с кнопкой [Удалить].`,
      html``,
      html`/today — траты группы за сегодня`,
      html`/week и /month — по категориям и по участникам`,
      html`/budget — бюджет группы: сколько осталось на сегодня и до конца периода`,
      html`/card — ответом на сообщение с тратой: показать её карточку`,
      html`/settings — часовой пояс и валюта группы (для того, кто добавил меня)`,
      html`/help — эта подсказка`,
      html``,
      html`Личные траты из переписки со мной сюда не попадают.`,
    ],
    '\n',
  ),
  // The command list shown in groups (BotCommandScopeAllGroupChats).
  groupCommands: [
    { command: 'today', description: 'Траты группы за сегодня' },
    { command: 'week', description: 'Траты за неделю по категориям и участникам' },
    { command: 'month', description: 'Траты за месяц по категориям и участникам' },
    { command: 'budget', description: 'Бюджет группы: сколько осталось' },
    { command: 'card', description: 'Ответом на трату: показать её карточку' },
    { command: 'settings', description: 'Часовой пояс и валюта группы' },
    { command: 'help', description: 'Как записать трату группы' },
  ],
  editedMessageHint: html`Изменение сообщения не меняет запись. Нажмите «Изменить» под подтверждением.`,
  invalidAmount: html`Не удалось разобрать сумму. Отправьте, например, «450 кофе» или «12,50 EUR такси». Тысячи отделяйте пробелом: «1 200 обед».`,
  futureDate: html`Эта дата ещё не наступила. Ничего не записано. Укажите прошедшую дату, например «450 такси вчера» или «450 такси 25.09».`,

  // `… — кофе · Кафе и рестораны`. An expense from before categories existed has none to show.
  expenseRecorded: (view: RecordedView): Html => {
    const { occurredOn } = view.expense;
    const line = expenseLine(
      'Записано в',
      view,
      occurredOn === view.sentOn ? undefined : shownDate(occurredOn, view.sentOn),
    );
    const { category } = view.expense;
    const card = category === null ? line : joinHtml([line, html`${category.name}`], ' · ');
    const { budget, cap } = view;
    return joinHtml(
      [
        card,
        ...(budget === undefined ? [] : [budgetLine(budget)]),
        ...(cap === undefined ? [] : [capLine(cap, cap.currency)]),
      ],
      '\n',
    );
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

  // The edit flow on the card (ADR-0009, ADR-0011): a field picker, then a prompt in the card.
  editButton: 'Изменить',
  editPicker: (view: ExpenseView): Html =>
    joinHtml([expenseLine('Записано в', view), html`Что изменить?`], '\n'),
  editAmountButton: 'Сумма',
  editDescriptionButton: 'Описание',
  editDateButton: 'Дата',
  amountPrompt: (current: Money): Html =>
    html`Сейчас: ${formatMoney(current)}. Введите новую сумму, например «1 200» или «12,50 EUR».`,
  descriptionPrompt: (current: string): Html =>
    html`Сейчас: ${shownDescription(current)}. Введите новое описание.`,
  // `today` is the user's local date: a date in another year shows it.
  datePrompt: ({ date, today }: { date: LocalDate; today: LocalDate }): Html =>
    html`Сейчас: ${shownDate(date, today)}. Выберите дату или введите её, например «25.09» или «вчера».`,
  todayButton: 'Сегодня',
  yesterdayButton: 'Вчера',
  dayBeforeButton: 'Позавчера',
  // Asked above the prompt again when an answer is refused; the flow stays pending.
  editRefused: {
    invalidAmount: html`Не удалось разобрать сумму.`,
    ambiguousAmount: (readings: readonly Money[]): Html =>
      html`Сумму можно понять по-разному: ${readings.map(formatMoney).join(' или ')}. Ничего не изменено. Тысячи отделяйте пробелом («1 200»), копейки — запятой («1,20»).`,
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    expenseShaped: html`Похоже на трату. Сейчас я жду новое значение. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.`,
    empty: html`Описание не может быть пустым.`,
    invalidDate: html`Не удалось разобрать дату.`,
    futureDate: html`Эта дата ещё не наступила.`,
  },
  expenseEditedToast: 'Трата изменена',
  dateUnchanged: 'Эта дата уже выбрана',
  dateUnavailable: 'Эту дату нельзя выбрать',
  editForbidden: 'Изменить трату может только тот, кто её записал',
  // A typed answer that arrives after the expense was deleted mid-flow.
  editGone: html`Трата удалена, изменение не сохранено.`,

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
  // The essential-category picker (ADR-0017): a set, not a toggle, per button.
  essentialCategoriesButton: 'Обязательные',
  essentialPicker: html`Обязательные траты — то, без чего не обойтись: жильё, продукты, связь. Бюджет, который считает только необязательные траты, их не учитывает. Отмеченные ✓ — обязательные; нажмите категорию, чтобы изменить.`,
  essentialChoice: (name: string, essential: boolean): string => (essential ? `✓ ${name}` : name),
  essentialSetToast: (essential: boolean): string =>
    essential ? 'Категория отмечена как обязательная' : 'Категория отмечена как необязательная',
  essentialUnchanged: 'Уже отмечено',
  categoryLimitToast: 'Категорий уже 30. Скройте ненужную, чтобы добавить новую.',
  fallbackCategoryToast: '«Другое» нельзя скрыть',
  categoryGoneToast: 'Категория не найдена',
  flowExpired: html`Время ответа истекло. Начните заново.`,
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
  // The hub scoped to a shared ledger (ADR-0015): the ledger's own zone and currency.
  ledgerSettingsScreen: ({ timezone, ledger }: SettingsScreenView): Html =>
    joinHtml(
      [
        html`<b>Настройки «${ledgerName(ledger)}»</b>`,
        html`Часовой пояс группы: ${timezoneName(timezone)}. Ваш личный часовой пояс не меняется.`,
        html`Валюта по умолчанию для новых трат: ${ledger.defaultCurrency}`,
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

  // The /budget screen (ADR-0017). Amounts are in the budget's currency; spend in other
  // currencies is listed as not counted.
  budgetScreen: ({ ledger, status }: BudgetScreenView): Html => {
    const title = html`<b>Бюджет «${ledgerName(ledger)}»</b>`;
    const noLimit = html`Лимит не задан. Задайте лимит на период, и после каждой траты я покажу, сколько осталось на сегодня.`;
    if (status === undefined) return joinHtml([title, noLimit], '\n');
    const { currency, period, limit } = status;
    const lines = [
      title,
      html`Период: ${weekRange(period, GENITIVE_MONTHS)}, день ${period.day} из ${period.days}`,
      status.scope === 'optional'
        ? html`Считаются только необязательные траты.`
        : html`Считаются все траты.`,
    ];
    if (limit === undefined) {
      lines.push(noLimit);
    } else {
      lines.push(
        html`Лимит: ${formatMoney({ amountMinor: limit.limitMinor, currency })}, потрачено ${formatMoney({ amountMinor: limit.spentMinor, currency })}`,
        html`${todayLeft(limit.todayLeftMinor, currency)}`,
        limit.periodLeftMinor < 0
          ? html`Перерасход за период: ${formatMoney({ amountMinor: -limit.periodLeftMinor, currency })}`
          : html`Осталось до ${shortDate(period.to)}: ${formatMoney({ amountMinor: limit.periodLeftMinor, currency })}`,
      );
    }
    if (status.caps.length > 0) {
      lines.push(html`<b>По категориям</b>`, ...status.caps.map((cap) => capLine(cap, currency)));
    }
    if (status.notCounted.size > 0) {
      const amounts = [...status.notCounted].map(([code, amountMinor]) =>
        formatMoney({ amountMinor, currency: code }),
      );
      lines.push(html`Не учтено, другая валюта: ${amounts.join(', ')}`);
    }
    if (currency !== ledger.defaultCurrency) {
      lines.push(
        html`Бюджет в ${currency}, а новые траты — в ${ledger.defaultCurrency}. Задайте лимит заново, чтобы перейти на ${ledger.defaultCurrency}.`,
      );
    }
    return joinHtml(lines, '\n');
  },
  // /budget in a bound group: the same figures, read-only. Without a budget, where to set one.
  groupBudget: (view: BudgetScreenView): Html => {
    const { status } = view;
    if (status === undefined || (status.limit === undefined && status.caps.length === 0)) {
      return joinHtml(
        [
          html`<b>Бюджет «${ledgerName(view.ledger)}»</b>`,
          html`Бюджет не задан. Его настраивает в личной переписке со мной тот, кто добавил меня в группу: /settings в группе, затем «Бюджет».`,
        ],
        '\n',
      );
    }
    return messages.budgetScreen(view);
  },
  // The group ledger's settings hub opens its budget screen (owner only).
  settingsBudgetButton: 'Бюджет',
  budgetNotOwnerToast: 'Бюджет группы может менять только тот, кто добавил меня в группу',
  budgetLimitButton: 'Задать лимит',
  budgetOwnerOnly: html`Бюджет этого учёта может настраивать только его владелец.`,
  // `current` is the limit in effect, if any.
  budgetLimitPrompt: ({
    currency,
    current,
  }: {
    currency: CurrencyCode;
    current?: Money | undefined;
  }): Html => {
    const ask = html`Лимит на период в ${currency}. Отправьте сумму, например «30 000».`;
    return current === undefined
      ? ask
      : joinHtml([html`Сейчас: ${formatMoney(current)}.`, ask], ' ');
  },
  budgetStartDayButton: 'День начала периода',
  // Category caps (ADR-0017): a paged category list, then a prompt per category.
  budgetCapsButton: 'Лимиты по категориям',
  budgetCapsPicker: html`Лимит на период для категории. Выберите категорию, чтобы задать или убрать лимит.`,
  // A category's label in the list: its cap, when it has one.
  capChoice: (name: string, cap: Money | null): string =>
    cap === null ? name : `${name} — ${formatMoney(cap)}`,
  budgetCapPrompt: ({
    name,
    currency,
    current,
  }: {
    name: string;
    currency: CurrencyCode;
    current?: Money | undefined;
  }): Html => {
    const ask = html`Лимит на период для «${name}» в ${currency}. Отправьте сумму, например «5 000».`;
    return current === undefined
      ? ask
      : joinHtml([html`Сейчас: ${formatMoney(current)}.`, ask], ' ');
  },
  budgetCapClearButton: 'Убрать лимит',
  capClearedToast: 'Лимит категории убран',
  capUnchanged: 'У категории нет лимита',
  // The two scope buttons; the current one is marked with currentChoice.
  budgetScopeButton: (scope: 'all' | 'optional'): string =>
    scope === 'all' ? 'Считать все' : 'Только необязательные',
  budgetScopeChangedToast: 'Готово',
  budgetScopeUnchanged: 'Уже выбрано',
  // A month too short for the day starts its period on its last day (ADR-0017).
  budgetStartDayPrompt: (current: number): Html =>
    html`Сейчас период начинается ${current}-го числа. Отправьте день месяца от 1 до 31, например «10» — день зарплаты. Если в месяце нет такого дня, период начнётся в последний день месяца.`,
  // Asked above the prompt again when an answer is refused; the flow stays pending.
  budgetRefused: {
    invalidAmount: html`Не удалось разобрать сумму.`,
    ambiguousAmount: (readings: readonly Money[]): Html =>
      html`Сумму можно понять по-разному: ${readings.map(formatMoney).join(' или ')}. Тысячи отделяйте пробелом («30 000»), копейки — запятой («1,20»).`,
    tooLarge: html`Слишком большая сумма.`,
    invalidDay: html`Нужен день месяца от 1 до 31.`,
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    // Keyed by the flow the prompt belongs to.
    expenseShaped: {
      budgetLimit: html`Похоже на трату. Сейчас я жду лимит. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.`,
      budgetStartDay: html`Похоже на трату. Сейчас я жду день месяца. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.`,
      budgetCap: html`Похоже на трату. Сейчас я жду лимит категории. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.`,
    },
  },

  // Navigation kit (ADR-0011). «Назад» is never a pager label.
  backButton: '« Назад',
  pagerPrev: '◀',
  pagerNext: '▶',
  pagerPosition: (page: number, pageCount: number): string => `${page}/${pageCount}`,
  // The current value in a picker.
  currentChoice: (label: string): string => `✓ ${label}`,

  today: ({ ledger, date, totals, people }: TodayView): Html => {
    const header = html`<b>Сегодня, ${dayMonth.format(new Date(`${date}T00:00:00Z`))} — «${ledgerName(ledger)}»</b>`;
    if (totals.size === 0) return joinHtml([header, noExpenses], '\n');
    const lines = [...totals].map(
      ([currency, amountMinor]) => html`${formatMoney({ amountMinor, currency })}`,
    );
    return joinHtml([joinHtml([header, ...lines], '\n'), ...peopleSection(people)], '\n\n');
  },

  // /week and /month: per currency a bold total, then its categories by amount. A summary too
  // long for one message shows the totals alone, with a note.
  periodSummary: ({ ledger, period, currencies, people }: SummaryView): Html => {
    const title =
      period.kind === 'month'
        ? `${MONTHS[dateParts(period.from).month] ?? ''} ${dateParts(period.from).year}`
        : `Неделя, ${weekRange(period, GENITIVE_MONTHS)}`;
    const header = html`<b>${title} — «${ledgerName(ledger)}»</b>`;
    if (currencies.length === 0) return joinHtml([header, noExpenses], '\n');
    const total = (c: SummaryView['currencies'][number]) =>
      html`<b>${formatMoney({ amountMinor: c.totalMinor, currency: c.currency })}</b>`;
    const blocks = currencies.map((c) =>
      joinHtml(
        [
          total(c),
          ...c.lines.map(
            (line) =>
              html`${line.name ?? 'Без категории'}: ${amountOnly({ amountMinor: line.amountMinor, currency: c.currency })}`,
          ),
        ],
        '\n',
      ),
    );
    const full = joinHtml([header, ...blocks, ...peopleSection(people)], '\n\n');
    if (visibleLength(full) <= MAX_VISIBLE_CHARS) return full;
    return joinHtml(
      [
        joinHtml([header, ...currencies.map(total)], '\n'),
        ...peopleSection(people),
        html`Категорий слишком много для одного сообщения, поэтому показаны только итоги.`,
      ],
      '\n\n',
    );
  },
  periodPrev: (period: PeriodRef): string => `◀ ${periodLabel(period)}`,
  periodNext: (period: PeriodRef): string => `${periodLabel(period)} ▶`,

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
