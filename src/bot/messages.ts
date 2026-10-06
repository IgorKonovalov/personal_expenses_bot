import type { LedgerKind } from '../db/ledgers.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { ExportRange } from '../domain/export/rows.js';
import { formatMoney, type Money } from '../domain/money.js';
import type { Schedule } from '../domain/schedule.js';
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
    // Normalized names without `#`; none when absent.
    readonly tags?: readonly string[];
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
  // Absent for an expense not recorded from a receipt.
  readonly receipt?: ReceiptLineView | undefined;
}

interface ReceiptLineView {
  readonly state: 'pending' | 'fetched' | 'failed';
  readonly sellerName: string | null;
  readonly itemCount: number;
}

interface ReceiptItemsView {
  readonly sellerName: string;
  readonly currency: CurrencyCode;
  readonly items: readonly {
    readonly name: string;
    // Decimal source text, e.g. `0.535`.
    readonly quantity: string;
    readonly totalMinor: number;
  }[];
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
        // True when foreign spending was converted into the figures (ADR-0023).
        readonly converted?: boolean | undefined;
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

// A tag on /tags: its total in the ledger's currency, and per currency what had no rate.
interface TagTotalView {
  readonly name: string;
  readonly converted: Money | undefined;
  readonly unconverted: readonly Money[];
}

// One currency's block of a tag report: its total, then its categories by amount.
interface TagBlockView {
  readonly currency: CurrencyCode;
  readonly totalMinor: number;
  // `name` null: the expenses without a category.
  readonly lines: readonly { readonly name: string | null; readonly amountMinor: number }[];
}

// A tag's report (ADR-0029): the converted block first, then each currency with no rate.
interface TagReportView {
  readonly ledger: LedgerRef;
  readonly report: {
    readonly name: string;
    readonly converted: TagBlockView | undefined;
    readonly convertedFrom: readonly Money[];
    readonly unconverted: readonly TagBlockView[];
    readonly count: number;
    readonly firstOn: LocalDate;
    readonly lastOn: LocalDate;
  };
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

// A group report's per-person section: each member's converted total, then each currency with
// no rate, never added to it. `converted` marks a first total holding foreign spending
// (ADR-0022). `name` is the member's Telegram first name (user text), null when never stored.
type PeopleView = readonly {
  readonly name: string | null;
  readonly totals: readonly Money[];
  readonly converted?: boolean | undefined;
}[];

interface TodayView {
  readonly ledger: LedgerRef;
  readonly date: LocalDate;
  // The first total holds the converted spending when `convertedFrom` is non-empty.
  readonly totals: ReadonlyMap<CurrencyCode, number>;
  // As in SummaryView. Absent is empty.
  readonly convertedFrom?: readonly Money[] | undefined;
  readonly unconverted?: readonly CurrencyCode[] | undefined;
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
  // Non-empty when the first block holds converted foreign spending (ADR-0022). Absent is empty.
  readonly convertedFrom?: readonly Money[] | undefined;
  // The currencies left in their own blocks for want of a rate. Absent is empty.
  readonly unconverted?: readonly CurrencyCode[] | undefined;
  readonly people?: PeopleView | undefined;
}

// A bank statement's preview (Plan 0027): the new purchases a tap would record, and one page of
// the listed rows. Merchants are bank text and go through `html`.
interface StatementPreviewView {
  readonly period: { readonly from: LocalDate; readonly to: LocalDate } | undefined;
  readonly ledger: LedgerRef;
  // Every card purchase in the file.
  readonly purchaseCount: number;
  // Rows already in the ledger: matched to a recorded expense, or imported before.
  readonly alreadyCount: number;
  readonly fresh: readonly Money[];
  // The page's rows: new ones first, then the ones a recorded expense covers (`already`).
  readonly rows: readonly StatementRowView[];
}

interface StatementRowView extends Money {
  readonly date: LocalDate;
  readonly merchant: string;
  readonly already: boolean;
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

const helpDonateLine = html`Бот бесплатный. Поддержать: /donate`;

// What a converted report was converted from, and what it could not convert (ADR-0022). Empty
// when nothing was foreign.
function conversionNotes(
  convertedFrom: readonly Money[],
  unconverted: readonly CurrencyCode[],
): Html[] {
  const notes: Html[] = [];
  if (convertedFrom.length > 0) {
    notes.push(
      html`Включая ${convertedFrom.map(formatMoney).join(', ')} по курсу НБС на день траты.`,
    );
  }
  if (unconverted.length > 0) {
    notes.push(html`Без курса НБС, не пересчитано: ${unconverted.join(', ')}.`);
  }
  return notes.length === 0 ? [] : [joinHtml(notes, '\n')];
}

// The privacy policy in the public repo; /privacy links it.
const PRIVACY_URL = 'https://github.com/IgorKonovalov/personal_expenses_bot/blob/main/PRIVACY.md';

// A group member with no stored display name: a deleted account, whose expenses stay in the
// group's totals (ADR-0024).
const DELETED_MEMBER = 'удалённый участник';

// `Анна: ≈ 1 650.00 RSD, 5 000.00 KZT` per member, under a heading. Empty when nobody spent.
function peopleSection(people: PeopleView | undefined): Html[] {
  if (people === undefined || people.length === 0) return [];
  return [
    joinHtml(
      [
        html`<b>По участникам</b>`,
        ...people.map(
          (person) =>
            html`${person.name ?? DELETED_MEMBER}: ${person.converted === true ? '≈ ' : ''}${person.totals.map(formatMoney).join(', ')}`,
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

// `1 позиция`, `2 позиции`, `5 позиций`, `21 позиция`.
function itemCount(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} позиций`;
  if (ones === 1) return `${n} позиция`;
  if (ones >= 2 && ones <= 4) return `${n} позиции`;
  return `${n} позиций`;
}

// `1 покупка`, `2 покупки`, `5 покупок`, `21 покупка`.
function purchaseCountWords(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} покупок`;
  if (ones === 1) return `${n} покупка`;
  if (ones >= 2 && ones <= 4) return `${n} покупки`;
  return `${n} покупок`;
}

// `01.09.2026` from a local date.
function numericDate(date: LocalDate): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
}

// Totals per currency, never converted: `1 234.56 RSD, 15.00 USD`.
function moneyTotals(rows: readonly Money[]): string {
  const totals = new Map<CurrencyCode, number>();
  for (const { currency, amountMinor } of rows) {
    totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
  }
  return [...totals]
    .map(([currency, amountMinor]) => formatMoney({ amountMinor, currency }))
    .join(', ');
}

// `12.09 · 450.00 RSD · KAFE PRIMER`, with ` · уже записано` for a row a recorded expense covers.
function statementRowLine(row: StatementRowView): Html {
  const line = html`${row.date.slice(8, 10)}.${row.date.slice(5, 7)} · ${formatMoney(row)} · ${shownDescription(row.merchant)}`;
  return row.already ? joinHtml([line, html`уже записано`], ' · ') : line;
}

// In a statement preview, in place of [Записать все] when every row is already recorded.
const statementNothingNew = html`Новых покупок нет: всё из выписки уже записано.`;

// `1 расход`, `2 расхода`, `5 расходов`, `21 расход`.
function expenseCountWords(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} расходов`;
  if (ones === 1) return `${n} расход`;
  if (ones >= 2 && ones <= 4) return `${n} расхода`;
  return `${n} расходов`;
}

// An export's period by its file key: `сентябрь 2026`, `2026 год`, `всё время`.
function exportPeriodName(key: string): string {
  if (key === 'all') return 'всё время';
  if (/^\d{4}$/.test(key)) return `${key} год`;
  const month = MONTHS[Number(key.slice(5, 7)) - 1] ?? '';
  return `${month.toLowerCase()} ${key.slice(0, 4)}`;
}

// `Test Market · 12 позиций` once fetched, a note once the fetch gave up, nothing while pending.
function receiptLine({ state, sellerName, itemCount: n }: ReceiptLineView): Html[] {
  if (state === 'fetched' && sellerName !== null) {
    return [html`${shownDescription(sellerName)} · ${itemCount(n)}`];
  }
  return state === 'failed' ? [html`Позиции не загрузились.`] : [];
}

// `3. Хлеб × 0.535 — 79.99 RSD`: the quantity only when it isn't 1.
function receiptItemLine(
  position: number,
  item: ReceiptItemsView['items'][number],
  currency: CurrencyCode,
): Html {
  const quantity = /^1(?:\.0*)?$/.test(item.quantity) ? '' : ` × ${item.quantity}`;
  return html`${position}. ${shownDescription(item.name)}${quantity} — ${formatMoney({ amountMinor: item.totalMinor, currency })}`;
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

// One person's balance in one currency. Positive: they owe the user.
interface DebtLineView extends Money {
  readonly name: string;
}

interface DebtRecordedView {
  readonly kind: 'lend' | 'borrow' | 'repaid_to_me' | 'i_repaid';
  readonly money: Money;
  readonly balance: DebtLineView;
}

const DEBT_KIND_LABELS: Readonly<Record<DebtRecordedView['kind'], string>> = {
  lend: 'вы дали в долг',
  borrow: 'вы взяли в долг',
  repaid_to_me: 'вам вернули',
  i_repaid: 'вы вернули',
};

// `Петя — должен вам 5 000.00 RSD`, `Аня — вы должны 20.00 EUR`, `Петя — долга нет`.
function debtLine({ name, amountMinor, currency }: DebtLineView): Html {
  if (amountMinor === 0) return html`${name} — долга нет`;
  const money = formatMoney({ amountMinor: Math.abs(amountMinor), currency });
  return amountMinor > 0 ? html`${name} — должен вам ${money}` : html`${name} — вы должны ${money}`;
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

// `#отпуск #рим`.
function tagWords(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(' ');
}

// A tag's converted total, then what had no rate: `1 914.04 RSD`, `450.00 RSD, 10.00 KZT`.
function tagTotals({ converted, unconverted }: TagTotalView): string {
  return [...(converted === undefined ? [] : [converted]), ...unconverted]
    .map(formatMoney)
    .join(', ');
}

// `28.09–30.09`, `30.09` for one day, `28.12.2025–02.01.2026` across a year.
function tagDateRange(first: LocalDate, last: LocalDate): string {
  const short = (date: LocalDate) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
  if (first === last) return short(first);
  return first.slice(0, 4) === last.slice(0, 4)
    ? `${short(first)}–${short(last)}`
    : `${numericDate(first)}–${numericDate(last)}`;
}

// `Ира: <b>2.00 RSD</b> — минуты буду`, or `Ира за 28 сентября: …` with a date.
function groupExpenseLine({ author, expense, sentOn }: GroupCardView): Html {
  const when = expense.occurredOn === sentOn ? '' : ` за ${shownDate(expense.occurredOn, sentOn)}`;
  return html`${author}${when}: <b>${formatMoney(expense)}</b> — ${shownDescription(expense.description)}`;
}

// A recurring rule in /recurring: what it records, and when.
interface RuleListView {
  // An expense rule's description, or a reminder's text.
  readonly description: string;
  // Absent for a reminder, and for a sealed rule while its ledger is locked.
  readonly money?: Money | undefined;
  // A sealed rule's template while its ledger is locked: nothing of it is shown.
  readonly locked?: boolean;
  readonly schedule: Schedule;
  readonly nextDueOn: LocalDate;
}

function recurringMonthly(day: number): string {
  return `Каждый месяц, ${day}-го`;
}

// The by-day form, ISO order: `по средам`.
const WEEKDAYS_BY_DAY = [
  'понедельникам',
  'вторникам',
  'средам',
  'четвергам',
  'пятницам',
  'субботам',
  'воскресеньям',
] as const;

// `weekday` is ISO: Monday 1.
function recurringWeekly(weekday: number): string {
  return `Каждую неделю, по ${WEEKDAYS_BY_DAY[weekday - 1] ?? ''}`;
}

// `dayMonth` is `DD.MM`.
function recurringYearly(dayMonth: string): string {
  return `Каждый год, ${dayMonth}`;
}

function scheduleLabel(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'monthly':
      return recurringMonthly(schedule.day);
    case 'weekly':
      return recurringWeekly(schedule.weekday);
    case 'yearly':
      return recurringYearly(
        `${String(schedule.day).padStart(2, '0')}.${String(schedule.month).padStart(2, '0')}`,
      );
  }
}

// `аренда — 45 000.00 RSD`, `🔔 заплатить за интернет`, or `🔒 Зашифрованная трата`.
function ruleTitle(rule: Pick<RuleListView, 'description' | 'money' | 'locked'>): string {
  if (rule.locked === true) return '🔒 Зашифрованная трата';
  return rule.money === undefined
    ? `🔔 ${shownDescription(rule.description)}`
    : `${shownDescription(rule.description)} — ${formatMoney(rule.money)}`;
}

// The title over `Каждый месяц, 1-го · следующая 1 ноября`.
function recurringRuleLines(rule: RuleListView, today: LocalDate): Html {
  return joinHtml(
    [
      html`${ruleTitle(rule)}`,
      html`${scheduleLabel(rule.schedule)} · следующая ${shownDate(rule.nextDueOn, today)}`,
    ],
    '\n',
  );
}

// /changelog shows this many versions, newest first; older ones are behind a link to the full
// CHANGELOG.md. A fixed count keeps the reply well under Telegram's 4096 characters as releases
// accumulate (messages.test.ts caps each announcement's length).
export const CHANGELOG_RECENT = 5;
const CHANGELOG_URL =
  'https://github.com/IgorKonovalov/personal_expenses_bot/blob/main/CHANGELOG.md';

// What's new, per release, keyed `X.Y.Z` (ADR-0013). The version in package.json needs an entry:
// messages.test.ts fails the gate otherwise. Bodies only; versionAnnouncement adds the envelope.
const versionAnnouncements: Readonly<Record<string, Html>> = {
  '0.19.0': html`Долги: /debts показывает, кто кому должен, по людям и валютам, и записывает возвраты. «1000 кафе /3» записывает вашу долю и спрашивает, кто должен остальное. В группе /settle показывает, кто кому сколько перевести.`,
  '0.18.0': html`Выписку Raiffeisen banka в PDF из e-banking можно прислать боту. Он найдёт покупки по карте, отметит уже записанные и одной кнопкой запишет остальные. Файл читается в памяти и не сохраняется.`,
  '0.17.0': html`Регулярные траты: под карточкой траты кнопка [Повторять] записывает её каждый месяц, неделю или год в 09:00 по вашему времени. Можно попросить бота сначала спрашивать сумму. /recurring показывает правила и добавляет напоминания.`,
  '0.16.0': html`/privacy рассказывает, какие данные хранит бот и куда они уходят. /delete_account удаляет ваш личный учёт со всеми тратами, чеками и настройками.`,
  '0.15.0': html`/export присылает траты за выбранный период файлом CSV или Excel, в личном чате и в группе.`,
  '0.14.0': html`Бот остаётся бесплатным для всех, без платных функций. Если хотите поддержать его, /donate принимает Telegram Stars, а пожертвование ничего не открывает. Вернуть пожертвование можно через /paysupport.`,
  '0.13.0': html`Бледный или мятый QR-код на фото чека бот теперь пробует прочитать ещё раз. Если не вышло, подскажет, как переснять.`,
  '0.12.0': html`Личный учёт можно зашифровать в /settings. Траты записываются как обычно, а итоги видны после /unlock с паролем. /lock закрывает учёт.`,
  '0.11.1': html`Исправление. После обновления бота курсы НБС загружаются сначала для последних дней с тратами, поэтому итоги /week и /month пересчитываются в одну валюту сразу, а не через несколько часов.`,
  '0.11.0': html`Итоги в разных валютах сводятся в одну сумму. /today, /week и /month показывают общий итог в валюте учёта: траты в EUR, USD и других валютах пересчитываются по среднему курсу НБС на день траты, а итог помечается «≈». Бюджет тоже учитывает такие траты. Валюты, которых нет в курсе НБС, например KZT, показываются отдельно.`,
  '0.10.0': html`Бот читает СМС банка о покупке картой. Перешлите или вставьте текст сербского СМС «Korišćenje kartice»: трата запишется в валюте покупки, с датой покупки и названием магазина. Повторно присланное СМС не записывается дважды.`,
  '0.9.3': html`Исправление. Бот читает чеки, в QR-коде которых ссылка разбита на строки или содержит «:443» после адреса сайта. Раньше такой чек не распознавался.`,
  '0.9.2': html`Исправление. Ссылка на чек с заметкой латиницей после неё, например «kafa», записывается как обычная трата, а не отклоняется как повреждённая.`,
  '0.9.1': html`Исправления. Ссылка на чек с заметкой после неё записывается как обычная трата. Групповая трата, открытая в личном чате, показывает дату по часовому поясу группы. Если после смены валюты задать бюджет заново, лимиты по категориям сбрасываются, и бот об этом пишет. На экранах бюджета появилась кнопка [« Назад], а в /help — команда /cancel.`,
  '0.9.0': html`Бот читает чеки из Сербии и Черногории. Пришлите фото QR-кода с чека или ссылку из него: трата запишется с суммой чека и его датой. Через несколько секунд под тратой появятся название магазина и кнопка [Позиции] со списком покупок. Повторно присланный чек не записывается дважды.`,
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
  // The bot's profile texts, set at boot with setMyDescription (the empty-chat card, at most 512
  // characters) and setMyShortDescription (the profile "About", at most 120). Plain text, no HTML.
  botDescription: [
    'Записываю личные траты прямо в чате.',
    '',
    'Отправьте «450 кофе» — трата записана, категория подобрана. Валюту и дату можно указать в той же строке: «12,50 EUR такси», «450 такси вчера».',
    '',
    'Читаю QR-коды чеков из Сербии и Черногории и СМС банка о покупке картой.',
    '',
    '/today, /week, /month — итоги по категориям, /budget — сколько осталось на сегодня. Траты в разных валютах пересчитываю по курсу НБС.',
    '',
    'Добавьте меня в группу — и у семьи будет общий учёт.',
  ].join('\n'),
  botShortDescription:
    'Учёт трат в чате: «450 кофе» — и записано. Чеки, СМС банка, бюджет и итоги по категориям.',
  // Bot command menu registered with setMyCommands at boot.
  commands: [
    { command: 'today', description: 'Траты за сегодня' },
    { command: 'week', description: 'Траты за неделю по категориям' },
    { command: 'month', description: 'Траты за месяц по категориям' },
    { command: 'budget', description: 'Бюджет: лимит и остаток на сегодня' },
    { command: 'recurring', description: 'Регулярные траты' },
    { command: 'debts', description: 'Долги: кто кому должен' },
    { command: 'tags', description: 'Метки: траты по поездкам и проектам' },
    { command: 'categories', description: 'Категории: добавить, переименовать, скрыть' },
    { command: 'export', description: 'Выгрузить расходы в CSV или Excel' },
    { command: 'settings', description: 'Часовой пояс, валюта и шифрование' },
    { command: 'unlock', description: 'Открыть зашифрованный учёт' },
    { command: 'lock', description: 'Закрыть зашифрованный учёт' },
    { command: 'help', description: 'Как записать трату' },
    { command: 'changelog', description: 'Что нового в боте' },
    { command: 'donate', description: 'Поддержать бота' },
  ],

  welcome: ({ timezone, currency }: { timezone: string; currency: CurrencyCode }): Html =>
    joinHtml(
      [
        html`Здравствуйте! Отправьте трату, например «450 кофе», и я её запишу. Итоги за сегодня: /today.`,
        html`Часовой пояс: ${timezoneName(timezone)}. Валюта: ${currency}. Изменить: /settings.`,
      ],
      '\n\n',
    ),
  // Admission (ADR-0024): a stranger's first private message, and a deep link that admits no one.
  invitationOnly: html`Бот работает по приглашениям. Попросите ссылку у того, кто вас пригласил.`,
  inviteInvalid: html`Ссылка недействительна или истекла.`,
  // The admin's /invite.
  inviteCreated: ({ link, maxUses, days }: { link: string; maxUses: number; days: number }): Html =>
    joinHtml(
      [html`Ссылка-приглашение: до ${maxUses} чел., действует ${days} дн.`, html`${link}`],
      '\n',
    ),
  inviteUsage: html`Использование: /invite — 10 человек, 14 дней; /invite 30 7 — 30 человек, 7 дней. Оба числа от 1 до 1000.`,
  // The admin's /invites: one line per live code, `abc… — 3/10, до 15 октября`, with a button each.
  inviteList: (
    codes: readonly {
      readonly code: string;
      readonly used: number;
      readonly maxUses: number;
      readonly expiresOn: LocalDate;
    }[],
  ): Html =>
    codes.length === 0
      ? html`Действующих ссылок нет. Новая: /invite.`
      : joinHtml(
          [
            html`<b>Действующие ссылки</b>`,
            ...codes.map(
              (c) =>
                html`<code>${c.code}</code> — ${c.used}/${c.maxUses}, до ${dayMonth.format(new Date(`${c.expiresOn}T00:00:00Z`))}`,
            ),
          ],
          '\n',
        ),
  inviteRevokeButton: (code: string): string => `Отключить ${code}`,
  inviteRevokedToast: 'Ссылка отключена',
  inviteAlreadyRevoked: 'Ссылка уже отключена',
  inviteNotFound: 'Ссылка не найдена',
  // The admin's /block and /unblock <telegram id>.
  blockUsage: html`Использование: /block 123456789 или /unblock 123456789 — числовой Telegram id.`,
  blocked: (id: number): Html => html`Пользователь ${id} заблокирован.`,
  alreadyBlocked: (id: number): Html => html`Пользователь ${id} уже заблокирован.`,
  unblocked: (id: number): Html => html`Пользователь ${id} разблокирован.`,
  notBlocked: (id: number): Html => html`Пользователь ${id} не заблокирован.`,
  blockUserNotFound: (id: number): Html => html`Пользователь ${id} мне не писал.`,
  blockAdmin: html`Администратора заблокировать нельзя.`,
  // The admin's /stats: counts only.
  stats: (view: {
    readonly admitted: number;
    readonly active: number;
    readonly expenses: number;
    readonly liveCodes: number;
  }): Html =>
    joinHtml(
      [
        html`Допущено пользователей: ${view.admitted}`,
        html`Записывали траты за 7 дней: ${view.active}`,
        html`Трат за 7 дней: ${view.expenses}`,
        html`Действующих ссылок: ${view.liveCodes}`,
      ],
      '\n',
    ),
  // /delete_account (ADR-0024): what goes, what stays, and the two buttons.
  deleteAccountPrompt: (backupKeep: number): Html =>
    joinHtml(
      [
        html`<b>Удалить аккаунт?</b>`,
        html`Удалится личный учёт: все траты, чеки, категории и бюджет, а также ваши настройки. Это нельзя отменить.`,
        html`Останутся траты в общих учётах групп — там вы будете показаны как «${DELETED_MEMBER}», и записи о пожертвованиях: без них нельзя вернуть платёж. В резервных копиях данные хранятся ещё до ${backupKeep} дн.`,
        html`После удаления пользоваться ботом можно будет только по новому приглашению.`,
      ],
      '\n\n',
    ),
  // /privacy: the policy itself is PRIVACY.md in the public repo.
  privacy: joinHtml(
    [
      html`Я храню ваш Telegram id, траты, чеки с позициями и настройки — на сервере в ЕС, с ежедневными резервными копиями.`,
      html`Данные видит администратор бота, кроме зашифрованного учёта. Наружу уходят только запросы чеков на налоговые сайты; рекламы и аналитики нет.`,
      html`Удалить всё: /delete_account.`,
      html``,
      html`Полная политика: ${PRIVACY_URL}`,
    ],
    '\n',
  ),
  deleteAccountButton: 'Удалить всё',
  // The author a group card names for an expense whose account was deleted.
  deletedMember: DELETED_MEMBER,
  accountDeleted: html`Аккаунт и личный учёт удалены.`,
  accountDeletedToast: 'Данные удалены',
  accountAlreadyDeleted: 'Данные уже удалены',
  accountKept: html`Ничего не удалено.`,
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
    const { category, tags = [] } = view.expense;
    return joinHtml(
      [
        groupExpenseLine(view),
        ...(category === null ? [] : [html`${category.name}`]),
        ...(tags.length === 0 ? [] : [html`${tagWords(tags)}`]),
      ],
      ' · ',
    );
  },
  groupExpenseDeleted: (view: GroupCardView): Html =>
    joinHtml([html`Удалено.`, groupExpenseLine(view)], ' '),
  // A deep link to the author's DM card, shown only to an admitted author (ADR-0014, ADR-0024).
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
      html`Задним числом: дата последним словом, например «450 такси вчера» или «450 такси 25.09».`,
      html`Под подтверждением: [Категория] — сменить категорию, [Изменить] — сумму, описание или дату, [Удалить] — удалить трату.`,
      html`Чек из Сербии или Черногории: отправьте фото QR-кода с чека или ссылку из него. Я запишу сумму, а через несколько секунд добавлю магазин и кнопку [Позиции].`,
      html`СМС банка о покупке картой: перешлите или вставьте его текст, и я запишу сумму, дату и магазин. Пока понимаю сербские СМС «Korišćenje kartice».`,
      html`Итоги и бюджет в разных валютах пересчитываются в одну валюту по курсу НБС на день траты.`,
      html`Выписка Raiffeisen banka Srbija: скачайте в e-banking выписку по счёту («Izvod po tekućem računu») в PDF и отправьте файл. Я покажу покупки картой и запишу их одним нажатием. Покупки, которые уже записаны (та же сумма в пределах дня), пропускаю; снятие наличных, комиссии, переводы и поступления не записываю.`,
      html`Аренда, подписки и другие регулярные траты: на карточке траты нажмите [Повторять] и выберите расписание. В этот день в 09:00 я сам запишу такую же трату или спрошу, записать ли.`,
      html`Долги: в /debts нажмите [Я дал в долг] или [Я взял в долг], отправьте сумму и выберите человека или напишите имя. Возврат — на карточке человека, в валюте долга. Счёт на несколько человек: «1000 кафе /3» запишет вашу долю, а остальных я спрошу, кто вам должен. Долги не входят в траты.`,
      html`Метки для поездок и проектов: добавьте к трате слово с #, например «450 кофе #отпуск». /tags покажет, сколько ушло на каждую метку, по категориям. «/tag отпуск» добавляет метку ко всем новым тратам, пока вы её не снимете.`,
      html``,
      html`${menu.today} — траты за сегодня`,
      html`${menu.week} и ${menu.month} — траты по категориям`,
      html`${menu.budget} — лимит и сколько осталось на сегодня`,
      html`${menu.settings} — часовой пояс, валюта, категории и шифрование`,
      html`${menu.help} — эта подсказка`,
      html`/recurring — регулярные траты и напоминания`,
      html`/debts — долги: кто кому должен`,
      html`/tags — метки и траты по ним, /tag — метка для всех новых трат`,
      html`/export — все траты файлом CSV или Excel, бесплатно и в любой момент`,
      html`/changelog — что нового в боте`,
      html`/cancel — отменить ввод`,
      html`/unlock и /lock — открыть и закрыть зашифрованный учёт, /recover — восстановить доступ по коду`,
      html`/privacy — какие данные хранятся и кто их видит`,
      html`/delete_account — удалить аккаунт и личный учёт`,
      html``,
      html`Общие траты семьи или компании: добавьте меня в группу. Там каждый записывает траты сам, а /month показывает итоги по категориям и по участникам. Личные траты отсюда в группу не попадают.`,
      html``,
      helpDonateLine,
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
      html`/settle — кто кому должен, если делить траты группы поровну, и кнопка [Перевёл]`,
      html`/export — все траты группы файлом CSV или Excel`,
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
    { command: 'settle', description: 'Кто кому должен: расчёт поровну' },
    { command: 'tags', description: 'Метки группы и траты по ним' },
    { command: 'tag', description: 'Метка для всех ваших новых трат, например /tag отпуск' },
    { command: 'export', description: 'Выгрузить траты группы в CSV или Excel' },
    { command: 'card', description: 'Ответом на трату: показать её карточку' },
    { command: 'settings', description: 'Часовой пояс и валюта группы' },
    { command: 'help', description: 'Как записать трату группы' },
  ],
  editedMessageHint: html`Изменение сообщения не меняет запись. Нажмите «Изменить» под подтверждением.`,
  tooManyTags: html`Больше 5 меток на одну трату не бывает. Ничего не записано. Отправьте, например, «450 кофе #отпуск #рим».`,
  // /tags (ADR-0029): one page of the ledger's tags, most recently used first.
  tagsEmpty: html`Меток пока нет. Добавьте метку словом с #, например «450 кофе #отпуск».`,
  tagList: ({
    ledger,
    tags,
  }: {
    readonly ledger: LedgerRef;
    readonly tags: readonly TagTotalView[];
  }): Html =>
    joinHtml(
      [
        html`<b>Метки — «${ledgerName(ledger)}»</b>`,
        ...tags.map((tag) => html`#${tag.name} — ${tagTotals(tag)}`),
      ],
      '\n',
    ),
  tagButton: (name: string): string => `#${name}`,
  // The sticky tag (ADR-0029), set with /tag in the active ledger.
  stickyTagOn: ({ ledger, name }: { ledger: LedgerRef; name: string }): Html =>
    html`Метка #${name} включена: я добавлю её к каждой новой трате в «${ledgerName(ledger)}», пока вы её не снимете.`,
  // A sealed ledger keeps the sticky tag in memory only (ADR-0029).
  stickyTagOnSealed: ({ ledger, name }: { ledger: LedgerRef; name: string }): Html =>
    html`Метка #${name} включена: я добавлю её к каждой новой трате в «${ledgerName(ledger)}», пока вы её не снимете. Учёт зашифрован, поэтому метка действует до перезапуска бота.`,
  stickyTagCurrent: ({ ledger, name }: { ledger: LedgerRef; name: string }): Html =>
    html`Сейчас к каждой новой трате в «${ledgerName(ledger)}» добавляется метка #${name}.`,
  stickyTagNone: html`Постоянной метки нет. Отправьте, например, «/tag отпуск» — и я добавлю #отпуск к каждой новой трате, пока вы её не снимете.`,
  stickyTagUsage: html`Укажите одну метку: буквы, цифры или _, до 32 знаков. Например, «/tag отпуск».`,
  stickyTagOff: html`Метка снята. Новые траты записываются без неё.`,
  stickyTagOffButton: 'Снять метку',
  // /tag in a group from someone who has recorded nothing there yet.
  groupStickyTagNotMember: html`Сначала запишите здесь хотя бы одну трату, например «450 кафе».`,
  // A tag button whose tag no live expense carries any more; the list is shown again.
  tagGone: 'Этой метки больше нет',
  // The tag's total, count and dates, then each currency's categories by amount; the first
  // block is `≈` when it holds converted spending, and the conversion notes close it.
  tagReport: ({ ledger, report }: TagReportView): Html => {
    const header = joinHtml(
      [
        html`<b>#${report.name} — «${ledgerName(ledger)}»</b>`,
        html`${tagDateRange(report.firstOn, report.lastOn)} · ${expenseCountWords(report.count)}`,
      ],
      '\n',
    );
    const converted = report.converted === undefined ? [] : [report.converted];
    const approximate = report.convertedFrom.length > 0;
    const blocks = [...converted, ...report.unconverted].map((block, index) =>
      joinHtml(
        [
          html`<b>${index < converted.length && approximate ? '≈ ' : ''}${formatMoney({ amountMinor: block.totalMinor, currency: block.currency })}</b>`,
          ...block.lines.map(
            (line) =>
              html`${line.name ?? 'Без категории'}: ${formatMoney({ amountMinor: line.amountMinor, currency: block.currency })}`,
          ),
        ],
        '\n',
      ),
    );
    return joinHtml(
      [
        header,
        ...blocks,
        ...conversionNotes(
          report.convertedFrom,
          report.unconverted.map((block) => block.currency),
        ),
      ],
      '\n\n',
    );
  },
  invalidAmount: html`Не удалось разобрать сумму. Отправьте, например, «450 кофе» или «12,50 EUR такси». Тысячи отделяйте пробелом: «1 200 обед».`,
  futureDate: html`Эта дата ещё не наступила. Ничего не записано. Укажите прошедшую дату, например «450 такси вчера» или «450 такси 25.09».`,

  // `… — кофе · Кафе и рестораны · #отпуск`. An expense from before categories existed has none
  // to show.
  expenseRecorded: (view: RecordedView): Html => {
    const { occurredOn } = view.expense;
    const line = expenseLine(
      'Записано в',
      view,
      occurredOn === view.sentOn ? undefined : shownDate(occurredOn, view.sentOn),
    );
    const { category, tags = [] } = view.expense;
    const card = joinHtml(
      [
        line,
        ...(category === null ? [] : [html`${category.name}`]),
        ...(tags.length === 0 ? [] : [html`${tagWords(tags)}`]),
      ],
      ' · ',
    );
    const { budget, cap, receipt } = view;
    return joinHtml(
      [
        card,
        ...(receipt === undefined ? [] : receiptLine(receipt)),
        ...(budget === undefined ? [] : [budgetLine(budget)]),
        ...(cap === undefined ? [] : [capLine(cap, cap.currency)]),
      ],
      '\n',
    );
  },
  // «Отменить» is never a label: it would read like the flows' «Отмена» (ADR-0011).
  undoButton: 'Удалить',

  // The same receipt or bank SMS sent again into the same ledger: above its existing card.
  alreadyRecorded: (card: Html): Html => joinHtml([html`Уже записано.`, card], '\n'),

  // Fiscal receipts (ADR-0018). The description a receipt expense carries until the shop's name
  // arrives.
  receiptPlaceholder: 'Чек',
  receiptRefused: {
    malformed: html`Не удалось прочитать чек: ссылка повреждена или обрезана. Ничего не записано. Скопируйте ссылку целиком или отправьте сумму текстом, например «829,12 чек».`,
    fractionalTotal: html`Не удалось прочитать сумму чека. Ничего не записано. Отправьте сумму текстом, например «829,12 чек».`,
    notSale: html`Это не чек продажи: копия, предварительный или авансовый счёт. Ничего не записано.`,
    refund: html`Это чек возврата. Возвраты пока не записываются, ничего не записано.`,
  },
  futureReceipt: html`Дата на чеке ещё не наступила. Ничего не записано.`,
  // The daily receipt cap (ADR-0024).
  receiptCapReached: html`Лимит чеков на сегодня исчерпан, попробуйте завтра.`,

  // Bank card-purchase SMS (ADR-0021): the header matched, but the body records nothing.
  bankSmsRefused: {
    malformed: html`Похоже на СМС банка о покупке, но прочитать его не удалось. Ничего не записано. Отправьте сумму текстом, например «450 кофе».`,
    unsupportedCurrency: (code: string): Html =>
      html`В СМС валюта ${code}, её я пока не знаю. Ничего не записано.`,
  },
  bankSmsFuture: html`Дата в СМС ещё не наступила. Ничего не записано.`,

  // A receipt card's buttons: the item list once fetched, a refetch once the fetch gave up.
  receiptItemsButton: 'Позиции',
  receiptRetryButton: 'Повторить',
  receiptItemsForbidden: 'Позиции видит только тот, кто записал трату',
  receiptItemsUnavailable: 'Позиции чека ещё не загружены',
  receiptRetryToast: 'Загружаю позиции',
  receiptRetryNotFailed: 'Позиции уже загружаются',
  receiptRetryForbidden: 'Повторить может только тот, кто записал трату',
  // The item list, edited into the card: pages of whole lines, each page's HTML within
  // Telegram's 4096 characters. Item names are shop text and go through `html`.
  receiptItemPages: ({ sellerName, currency, items }: ReceiptItemsView): Html[] => {
    const header = html`<b>${shownDescription(sellerName)}</b> · ${itemCount(items.length)}`;
    const pages: Html[] = [];
    let page = header;
    items.forEach((item, index) => {
      const line = receiptItemLine(index + 1, item, currency);
      if (page !== header && page.length + 1 + line.length > MAX_VISIBLE_CHARS) {
        pages.push(page);
        page = header;
      }
      page = joinHtml([page, line], '\n');
    });
    pages.push(page);
    return pages;
  },
  // A photo or image file where no QR symbol was located, or whose QR isn't a receipt; also an
  // image too large to download (ADR-0019, ADR-0034).
  receiptPhotoNoQr: html`Не нашёл QR-код чека на фото. Сфотографируйте его ближе, чтобы код занимал почти весь кадр, или вставьте ссылку из QR-кода.`,
  // A photo where a QR symbol was located but no pass read it (ADR-0034).
  receiptPhotoUnreadable: html`QR-код вижу, но прочитать не смог: на чеках он часто бледный или мятый. Расправьте чек и снимите ровно сверху, в фокусе и без бликов, или вставьте ссылку из QR-кода.`,

  // A bank statement PDF (Plan 0027): its card purchases, the new ones' totals per currency and
  // one page of rows, above [Записать все (N)], the pager and [Отмена].
  statementPreview: ({
    period,
    ledger,
    purchaseCount,
    alreadyCount,
    fresh,
    rows,
  }: StatementPreviewView): Html => {
    const title =
      period === undefined
        ? html`<b>Выписка</b> → «${ledgerName(ledger)}»`
        : html`<b>Выписка за ${numericDate(period.from)}–${numericDate(period.to)}</b> → «${ledgerName(ledger)}»`;
    const lines = [
      title,
      html`Найдено ${purchaseCountWords(purchaseCount)}, новых: ${fresh.length}`,
    ];
    // ADR-0032: the same amount and currency within a day, or recorded by an earlier import.
    if (alreadyCount > 0) lines.push(html`Уже записано: ${alreadyCount}`);
    lines.push(fresh.length === 0 ? statementNothingNew : html`На сумму: ${moneyTotals(fresh)}`);
    if (rows.length > 0) lines.push(html``, ...rows.map(statementRowLine));
    return joinHtml(lines, '\n');
  },
  statementRecordAllButton: (n: number): string => `Записать все (${n})`,
  // The new rows plus the ones a recorded expense already covers.
  statementRecordWithMatchedButton: (n: number): string => `Записать и уже записанные (${n})`,
  statementNothingNew,
  statementRecorded: ({
    ledger,
    count,
    totals,
  }: {
    readonly ledger: LedgerRef;
    readonly count: number;
    readonly totals: readonly Money[];
  }): Html =>
    count === 0
      ? html`Ничего нового: все покупки из выписки уже записаны.`
      : html`Записано в «${ledgerName(ledger)}»: ${purchaseCountWords(count)} на ${moneyTotals(totals)}.`,
  statementRecordedToast: 'Выписка записана',
  // Refusals, before any row is read (ADR-0033's caps).
  statementTooLarge: html`Файл больше 5 МБ, такую выписку я не читаю. Выгрузите в e-banking период покороче.`,
  statementTooLong: html`Выписка слишком длинная: больше 30 страниц или 1000 покупок. Выгрузите в e-banking период покороче.`,
  // A PDF with no text layer: a scan or a photo.
  statementNoText: html`В этом PDF нет текста, похоже на скан. Скачайте выписку в e-banking в формате PDF и отправьте файл.`,
  statementUnreadable: html`Не удалось прочитать этот PDF. Скачайте выписку в e-banking заново и отправьте ещё раз.`,
  statementCancelled: html`Выписка не записана.`,

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
    noTags: html`Не нашёл ни одной метки: метка начинается с #.`,
    tooManyTags: html`Больше 5 меток на одну трату не бывает.`,
  },
  editTagsButton: 'Метки',
  // The tags prompt (ADR-0029): the answer replaces every tag of the expense.
  tagsPrompt: (current: readonly string[]): Html => {
    const prompt = html`Отправьте метки через пробел, например «#отпуск #рим», или «-», чтобы убрать все.`;
    return current.length === 0
      ? prompt
      : joinHtml([html`Сейчас: ${tagWords(current)}.`, prompt], ' ');
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

  // Sealed personal ledgers (ADR-0020). A secret the user types is deleted at once; the bot
  // never repeats it.
  settingsEncryptionButton: 'Шифрование',
  encryptionEnablePrompt: joinHtml(
    [
      html`<b>Шифрование личного учёта</b>`,
      html`Суммы, описания и категории трат будут храниться зашифрованными. Записывать траты можно как обычно. Чтобы увидеть итоги, бюджет или карточку траты, учёт нужно открыть паролем: /unlock. Через 30 минут без просмотра, по /lock и после перезапуска бота учёт снова закрывается.`,
      html`Шифрование защищает базу данных и резервные копии. Оно не защищает от того, кто управляет ботом и может изменить его код, и от Telegram: траты и пароль проходят через Telegram.`,
      html`Если забыть и пароль, и код восстановления, траты не вернуть. Выключить шифрование нельзя.`,
      html`Отправьте пароль не короче 10 символов. Я сразу удалю сообщение с ним.`,
    ],
    '\n\n',
  ),
  // Asked above the prompt again; the flow stays pending.
  passphraseTooShort: html`Пароль слишком короткий: нужно не меньше 10 символов.`,
  encryptionPendingReceipts: html`Я ещё загружаю позиции чека. Шифрование не включено. Попробуйте через минуту.`,
  encryptionScreen: (state: 'locked' | 'unlocked'): Html =>
    joinHtml(
      [
        html`<b>Шифрование личного учёта</b>`,
        state === 'locked'
          ? html`Включено. Учёт закрыт, открыть: /unlock.`
          : html`Включено. Учёт открыт.`,
      ],
      '\n',
    ),
  // Sent as its own message, deleted when the user taps the button under it.
  recoveryCode: (code: string): Html =>
    joinHtml(
      [
        html`<b>Код восстановления</b>`,
        html`<code>${code}</code>`,
        html`Если забудете пароль, этот код вернёт доступ к учёту. Сохраните его в надёжном месте, например в менеджере паролей. Я больше не покажу этот код.`,
        html`Записанные траты теперь тоже зашифрованы. Резервные копии, сделанные до сегодняшнего дня, хранят их незашифрованными, пока не удалятся по расписанию.`,
        html`Нажмите «Сохранил», и я удалю это сообщение.`,
      ],
      '\n\n',
    ),
  recoverySavedButton: 'Сохранил',
  ledgerLocked: html`Учёт зашифрован и закрыт. Откройте его паролем: /unlock.`,
  ledgerLockedToast: 'Учёт зашифрован и закрыт. Откройте его: /unlock',
  receiptSealedLedger: html`Учёт зашифрован, а чеки в зашифрованный учёт пока не записываются. Ничего не записано. Запишите сумму текстом, например «450 продукты».`,
  // A redelivered expense in a locked ledger: it stays recorded, and nothing about it is shown.
  sealedDuplicate: html`Уже записано. Учёт зашифрован и закрыт, открыть: /unlock.`,
  unlockPrompt: html`Отправьте пароль учёта. Я сразу удалю сообщение с ним.`,
  unlockNotSealed: html`Личный учёт не зашифрован. Включить шифрование: /settings, затем «Шифрование».`,
  alreadyUnlocked: html`Учёт уже открыт.`,
  ledgerLockedNow: html`Учёт закрыт. Открыть: /unlock.`,
  alreadyLocked: html`Учёт уже закрыт.`,
  unlocked: html`Учёт открыт. Итоги за сегодня: /today.`,
  wrongPassphrase: html`Неверный пароль. Учёт по-прежнему закрыт. Попробовать ещё раз: /unlock.`,
  recoverPrompt: html`Отправьте код восстановления. Регистр и дефисы не важны. Я сразу удалю сообщение с ним.`,
  wrongRecoveryCode: html`Код не подошёл. Ничего не изменено. Попробовать ещё раз: /recover.`,
  recoveredPrompt: html`Код подошёл, учёт открыт. Отправьте новый пароль не короче 10 символов. Я сразу удалю сообщение с ним.`,
  changePassphraseButton: 'Сменить пароль',
  changePassphrasePrompt: html`Отправьте новый пароль не короче 10 символов. Я сразу удалю сообщение с ним. Код восстановления останется прежним.`,
  passphraseChanged: html`Пароль изменён. Код восстановления прежний.`,
  // The first text after a secret prompt expired: deleted unread, since it may be the secret.
  secretPromptExpired: html`Время ответа истекло, и я удалил это сообщение: в нём мог быть пароль или код. Если это была трата, отправьте её ещё раз.`,

  // The /budget screen (ADR-0017). Amounts are in the budget's currency, foreign spending
  // converted into it (ADR-0023); spend with no rate is listed as not counted. `readOnly` leaves out what only the owner can act on.
  budgetScreen: ({ ledger, status }: BudgetScreenView, readOnly = false): Html => {
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
    if (status.converted === true) {
      lines.push(html`Траты в других валютах пересчитаны по курсу НБС на день траты.`);
    }
    if (status.notCounted.size > 0) {
      const amounts = [...status.notCounted].map(([code, amountMinor]) =>
        formatMoney({ amountMinor, currency: code }),
      );
      lines.push(html`Не учтено, нет курса: ${amounts.join(', ')}`);
    }
    if (currency !== ledger.defaultCurrency) {
      const mismatch = html`Бюджет в ${currency}, а новые траты — в ${ledger.defaultCurrency}.`;
      lines.push(
        readOnly
          ? mismatch
          : joinHtml(
              [mismatch, html`Задайте лимит заново, чтобы перейти на ${ledger.defaultCurrency}.`],
              ' ',
            ),
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
    return messages.budgetScreen(view, true);
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
  // Above the budget screen after a limit in a new currency deleted the category caps.
  budgetCapsDropped: (currency: CurrencyCode): Html =>
    html`Лимиты по категориям сброшены: они были в ${currency}.`,
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

  // /export (ADR-0026): the range step, then the format step, edited in place.
  // A sealed ledger's picker says the file is a plaintext copy.
  exportRangePrompt: (sealed: boolean): Html =>
    sealed
      ? html`Что выгрузить?\n\nУчёт зашифрован, а файл — нет: копия останется в чате и на ваших устройствах.`
      : html`Что выгрузить?`,
  exportRangeButtons: {
    tm: 'Этот месяц',
    pm: 'Прошлый месяц',
    ty: 'Этот год',
    all: 'Всё время',
  } satisfies Record<ExportRange, string>,
  exportFormatPrompt: html`Формат файла?`,
  exportCsvButton: 'CSV',
  exportXlsxButton: 'Excel',
  exportBackButton: '← Назад',
  exportEmpty: html`За этот период расходов нет`,
  // `Готово: 2 расхода за сентябрь 2026`. `key` is the file key: `2026-09`, `2026` or `all`.
  exportDone: (count: number, key: string): Html =>
    html`Готово: ${expenseCountWords(count)} за ${exportPeriodName(key)}`,
  // The file stems, sheet names and column headers; a file is `<stem>-<key>.csv`.
  exportExpensesStem: 'expenses',
  exportItemsStem: 'receipt-items',
  exportExpensesSheet: 'Расходы',
  exportItemsSheet: 'Позиции чеков',
  exportColumns: (ledgerCurrency: CurrencyCode) => ({
    date: 'Дата',
    time: 'Время',
    amount: 'Сумма',
    currency: 'Валюта',
    converted: `Сумма в ${ledgerCurrency}`,
    category: 'Категория',
    description: 'Описание',
    tags: 'Метки',
    author: 'Автор',
    shop: 'Магазин',
    receipt: 'Чек',
    id: 'ID',
    unnamedAuthor: 'участник',
  }),
  exportItemColumns: {
    expenseId: 'ID расхода',
    date: 'Дата',
    shop: 'Магазин',
    position: '№',
    name: 'Наименование',
    quantity: 'Количество',
    amount: 'Сумма',
    currency: 'Валюта',
  },

  // Navigation kit (ADR-0011). «Назад» is never a pager label.
  backButton: '« Назад',
  pagerPrev: '◀',
  pagerNext: '▶',
  pagerPosition: (page: number, pageCount: number): string => `${page}/${pageCount}`,
  // The current value in a picker.
  currentChoice: (label: string): string => `✓ ${label}`,

  // The day's totals, the first `≈` when it holds converted spending, then the conversion notes.
  today: ({
    ledger,
    date,
    totals,
    convertedFrom = [],
    unconverted = [],
    people,
  }: TodayView): Html => {
    const header = html`<b>Сегодня, ${dayMonth.format(new Date(`${date}T00:00:00Z`))} — «${ledgerName(ledger)}»</b>`;
    if (totals.size === 0) return joinHtml([header, noExpenses], '\n');
    const lines = [...totals].map(
      ([currency, amountMinor], index) =>
        html`${index === 0 && convertedFrom.length > 0 ? '≈ ' : ''}${formatMoney({ amountMinor, currency })}`,
    );
    return joinHtml(
      [
        joinHtml([header, ...lines], '\n'),
        ...peopleSection(people),
        ...conversionNotes(convertedFrom, unconverted),
      ],
      '\n\n',
    );
  },

  // /week and /month: per currency a bold total, then its categories by amount. The first block
  // is `≈` when it holds converted spending, and the conversion notes close the message. A
  // summary too long for one message shows the totals alone, with a note.
  periodSummary: ({
    ledger,
    period,
    currencies,
    convertedFrom = [],
    unconverted = [],
    people,
  }: SummaryView): Html => {
    const title =
      period.kind === 'month'
        ? `${MONTHS[dateParts(period.from).month] ?? ''} ${dateParts(period.from).year}`
        : `Неделя, ${weekRange(period, GENITIVE_MONTHS)}`;
    const header = html`<b>${title} — «${ledgerName(ledger)}»</b>`;
    if (currencies.length === 0) return joinHtml([header, noExpenses], '\n');
    const total = (c: SummaryView['currencies'][number], index: number) =>
      html`<b>${index === 0 && convertedFrom.length > 0 ? '≈ ' : ''}${formatMoney({ amountMinor: c.totalMinor, currency: c.currency })}</b>`;
    const blocks = currencies.map((c, index) =>
      joinHtml(
        [
          total(c, index),
          ...c.lines.map(
            (line) =>
              html`${line.name ?? 'Без категории'}: ${amountOnly({ amountMinor: line.amountMinor, currency: c.currency })}`,
          ),
        ],
        '\n',
      ),
    );
    const notes = conversionNotes(convertedFrom, unconverted);
    const full = joinHtml([header, ...blocks, ...peopleSection(people), ...notes], '\n\n');
    if (visibleLength(full) <= MAX_VISIBLE_CHARS) return full;
    return joinHtml(
      [
        joinHtml([header, ...currencies.map(total)], '\n'),
        ...peopleSection(people),
        ...notes,
        html`Категорий слишком много для одного сообщения, поэтому показаны только итоги.`,
      ],
      '\n\n',
    );
  },
  // Recurring expenses (Plan 0025, ADR-0031). Occurrences fire at 09:00 in the ledger's zone.
  repeatButton: 'Повторять',
  repeatPicker: (view: ExpenseView): Html =>
    joinHtml(
      [
        expenseLine('Записано в', view),
        html`Как повторять? В этот день в 09:00 я сам запишу такую же трату.`,
      ],
      '\n',
    ),
  // A schedule as a button label and in lists: `Каждый месяц, 15-го`.
  scheduleLabel,
  recurringMonthly,
  recurringWeekly,
  recurringYearly,
  // Under the card once the rule exists. `today` is the ledger's local date.
  recurringCreated: ({
    schedule,
    nextDueOn,
    today,
  }: {
    schedule: Schedule;
    nextDueOn: LocalDate;
    today: LocalDate;
  }): Html =>
    html`Повторяется: ${scheduleLabel(schedule).toLowerCase()}. Следующая запись — ${shownDate(nextDueOn, today)}. Все правила: /recurring`,
  repeatForbidden: 'Повторять трату может только тот, кто её записал',
  // An occurrence the scheduler recorded: the usual confirmation, marked as recurring.
  recurringRecorded: (view: RecordedView): Html => {
    const { occurredOn, category } = view.expense;
    const line = joinHtml(
      [
        expenseLine(
          'Записано в',
          view,
          occurredOn === view.sentOn ? undefined : shownDate(occurredOn, view.sentOn),
        ),
        html`(регулярная)`,
      ],
      ' ',
    );
    return category === null ? line : joinHtml([line, html`${category.name}`], ' · ');
  },
  // An occurrence of a sealed ledger's rule (ADR-0035): no amount and no description, which the
  // bot can't read while the ledger is locked. `sentOn` is the ledger's local date.
  recurringRecordedSealed: ({
    occurredOn,
    sentOn,
  }: {
    occurredOn: LocalDate;
    sentOn: LocalDate;
  }): Html => {
    const when = occurredOn === sentOn ? '' : ` за ${shownDate(occurredOn, sentOn)}`;
    return html`Записана регулярная трата${when}. Учёт зашифрован: сумма и описание видны после /unlock.`;
  },
  // /recurring. `today` is the user's local date, for the year of a next date.
  recurringList: ({ rules, today }: { rules: readonly RuleListView[]; today: LocalDate }): Html => {
    const title = html`<b>Регулярные траты</b>`;
    if (rules.length === 0) {
      return joinHtml(
        [title, html`Пока ничего нет. Чтобы трата записывалась сама, нажмите «Повторять» под ней.`],
        '\n',
      );
    }
    return joinHtml([title, ...rules.map((rule) => recurringRuleLines(rule, today))], '\n\n');
  },

  // A rule's button on /recurring: `аренда — 45 000.00 RSD`.
  ruleButton: (rule: Pick<RuleListView, 'description' | 'money' | 'locked'>): string =>
    ruleTitle(rule),
  recurringRuleScreen: ({
    rule,
    mode,
    today,
  }: {
    rule: RuleListView;
    mode: 'auto' | 'ask';
    today: LocalDate;
  }): Html =>
    joinHtml(
      [
        recurringRuleLines(rule, today),
        rule.money === undefined && rule.locked !== true
          ? html`Напоминаю в 09:00.`
          : mode === 'auto'
            ? html`Записываю сам в 09:00.`
            : html`В 09:00 спрашиваю, записать ли, и с какой суммой.`,
      ],
      '\n',
    ),
  // Reminders: a text sent on its day, recording nothing. Personal and private.
  addReminderButton: 'Добавить напоминание',
  reminderTextPrompt: html`О чём напомнить? Отправьте текст до 200 символов, например «заплатить за интернет».`,
  // The prompt while the personal ledger is sealed: a reminder's text isn't ledger data.
  reminderTextPromptSealed: html`О чём напомнить? Отправьте текст до 200 символов, например «заплатить за интернет». Учёт зашифрован, а текст напоминания — нет: он хранится открытым.`,
  reminderTextRefused: {
    empty: html`Текст не может быть пустым.`,
    tooLong: html`Текст длиннее 200 символов.`,
    // ADR-0009: an expense typed into a prompt is neither recorded nor taken as the answer.
    expenseShaped: html`Похоже на трату. Сейчас я жду текст напоминания. Чтобы записать трату, нажмите «Отмена» и отправьте её снова.`,
  },
  reminderSchedulePicker: (text: string): Html =>
    html`Когда напоминать «${shownDescription(text)}»? В этот день в 09:00 я пришлю напоминание.`,
  reminderAdded: html`Напоминание добавлено.`,
  reminderDue: (text: string): Html => html`🔔 ${text}`,
  reminderExpenseButton: 'Записать трату',
  reminderExpenseHint: html`Отправьте трату, например «450 кофе».`,
  ruleAskModeButton: 'Спрашивать перед записью',
  ruleAutoModeButton: 'Записывать само',
  ruleModeToast: 'Готово',
  ruleDeleteButton: 'Удалить правило',
  ruleDeleteConfirmButton: 'Да, удалить',
  ruleDeleteConfirm: (description: string): Html =>
    html`Удалить правило «${shownDescription(description)}»? Уже записанные траты останутся.`,
  ruleDeleted: html`Правило удалено. Записанные траты остались.`,
  ruleGoneToast: 'Правило не найдено',
  // An `ask` occurrence's prompt. `today` is the ledger's local date.
  recurringAsk: ({
    description,
    money,
    dueOn,
    today,
  }: {
    description: string;
    money: Money;
    dueOn: LocalDate;
    today: LocalDate;
  }): Html =>
    html`По расписанию на ${shownDate(dueOn, today)}: ${shownDescription(description)}, ${formatMoney(money)}. Записать?`,
  // A sealed ledger's `ask` prompt (ADR-0035): no amount, no description, no other amount.
  recurringAskSealed: ({ dueOn, today }: { dueOn: LocalDate; today: LocalDate }): Html =>
    html`По расписанию на ${shownDate(dueOn, today)}: регулярная трата из зашифрованного учёта. Записать?`,
  askRecordButton: (money: Money): string => `Записать ${formatMoney(money)}`,
  askRecordSealedButton: 'Записать',
  askAmountButton: 'Другая сумма',
  askSkipButton: 'Пропустить',
  // Without a description for a sealed rule's prompt.
  recurringSkipped: (description?: string): Html =>
    description === undefined
      ? html`Пропущено.`
      : html`Пропущено: ${shownDescription(description)}.`,
  // Before the prompts after downtime: the missed dates not asked about.
  recurringAskMissed: (count: number): Html =>
    html`Пока я не работал, по расписанию прошло ещё ${count}, их я пропустил.`,
  askAmountPrompt: (currency: CurrencyCode): Html =>
    html`Введите сумму в ${currency}, например «4 870».`,
  askAmountRefused: html`Не удалось разобрать сумму.`,
  askAnswered: 'На это уже ответили',
  askRecordedToast: 'Записано',
  askForbidden: 'Ответить может только автор правила',
  askAmountSealedToast: 'В зашифрованном учёте записывается сумма из правила',

  // Personal debts (ADR-0030). A person's name is user text; people are picked by button, so a
  // name is never declined.
  debtsScreen: (lines: readonly DebtLineView[]): Html =>
    lines.length === 0
      ? html`Долгов нет. Записать долг — кнопками ниже.`
      : joinHtml([html`<b>Долги</b>`, ...lines.map(debtLine)], '\n'),
  lendButton: 'Я дал в долг',
  borrowButton: 'Я взял в долг',
  debtAmountPrompt: (direction: 'lend' | 'borrow', currency: CurrencyCode): Html =>
    direction === 'lend'
      ? html`Сколько вы дали в долг? Например, «5000» или «20 EUR». Без валюты — ${currency}.`
      : html`Сколько вы взяли в долг? Например, «5000» или «20 EUR». Без валюты — ${currency}.`,
  debtAmountRefused: html`Не удалось разобрать сумму.`,
  debtPersonPrompt: (direction: 'lend' | 'borrow', money: Money): Html =>
    direction === 'lend'
      ? html`Кому вы дали ${formatMoney(money)}? Выберите человека или отправьте имя.`
      : html`У кого вы взяли ${formatMoney(money)}? Выберите человека или отправьте имя.`,
  debtPersonRefused: {
    empty: html`Отправьте имя.`,
    tooLong: html`Имя длиннее 40 символов.`,
    expenseShaped: html`Это похоже на трату, а не на имя. Отправьте имя.`,
  },
  // A person's card: their balances, then their latest operations, newest first.
  debtCard: ({
    name,
    balances,
    history,
  }: {
    name: string;
    balances: readonly Money[];
    history: readonly { kind: DebtRecordedView['kind']; money: Money; occurredOn: LocalDate }[];
  }): Html =>
    joinHtml(
      [
        html`<b>${name}</b>`,
        balances.length === 0
          ? html`Долга нет.`
          : joinHtml(
              balances.map((b) =>
                b.amountMinor > 0
                  ? html`Должен вам ${formatMoney(b)}`
                  : html`Вы должны ${formatMoney({ ...b, amountMinor: -b.amountMinor })}`,
              ),
              '\n',
            ),
        ...(history.length === 0
          ? []
          : [
              joinHtml(
                [
                  html`<b>Последние операции</b>`,
                  ...history.map(
                    (op) =>
                      html`${shortDate(op.occurredOn)} · ${DEBT_KIND_LABELS[op.kind]} ${formatMoney(op.money)}`,
                  ),
                ],
                '\n',
              ),
            ]),
      ],
      '\n\n',
    ),
  repaidToMeButton: 'Мне вернули',
  iRepaidButton: 'Я вернул',
  repayCurrencyPrompt: (direction: 'toMe' | 'byMe'): Html =>
    direction === 'toMe' ? html`Какой долг вам вернули?` : html`Какой долг вы вернули?`,
  repayCurrencyButton: (balance: Money): string =>
    formatMoney({ ...balance, amountMinor: Math.abs(balance.amountMinor) }),
  repayAmountPrompt: (balance: Money): Html =>
    html`Сколько вернули? Весь долг — ${formatMoney({ ...balance, amountMinor: Math.abs(balance.amountMinor) })}. Сумма в ${balance.currency}.`,
  repayAllButton: 'Весь долг',
  debtWrongCurrency: (currency: CurrencyCode): Html =>
    html`Долг в ${currency}: вернуть его можно только в ${currency}.`,
  debtTooMuch: (balance: Money): Html =>
    html`Это больше долга: ${formatMoney({ ...balance, amountMinor: Math.abs(balance.amountMinor) })}.`,
  debtDeleted: ({ kind, money, balance }: DebtRecordedView): Html =>
    joinHtml(
      [html`Удалено: ${DEBT_KIND_LABELS[kind]} ${formatMoney(money)}.`, debtLine(balance)],
      '\n',
    ),
  debtDeletedToast: 'Удалено',
  debtAlreadyDeleted: 'Уже удалено',
  debtNotFound: 'Запись не найдена',
  // A `/N` expense: under its card, the whole it is a share of.
  splitShare: (whole: Money, parts: number): Html =>
    html`Это ваша доля из ${formatMoney(whole)} на ${parts}.`,
  splitPicker: (each: Money, needed: number): Html =>
    html`Кто должен вам по ${formatMoney(each)}? Выберите ${needed} — кнопками или отправьте имя.`,
  splitChoice: (name: string, chosen: boolean): string => (chosen ? `✓ ${name}` : name),
  splitDoneButton: (chosen: number, needed: number): string => `Готово (${chosen}/${needed})`,
  splitSkipButton: 'Пропустить',
  splitNeedPeople: (needed: number): string => `Выберите ровно ${needed}`,
  splitRecorded: (each: Money, names: readonly string[]): Html =>
    html`Записано: по ${formatMoney(each)} должны вам ${names.join(', ')}. Все долги: /debts.`,
  splitSkipped: html`Долги не записаны. Трата осталась вашей долей.`,
  splitInGroup: html`В группе траты делятся поровну автоматически: /settle`,
  // A `/N` split in a sealed ledger that is locked: the picker would show names (ADR-0020).
  splitLocked: html`Ваша доля записана. Учёт зашифрован и закрыт, поэтому долги не записаны: откройте его (/unlock) и добавьте их в /debts.`,
  // /settle in a group (ADR-0030). Names are members' Telegram first names (user text).
  settleScreen: ({
    names,
    currencies,
  }: {
    names: readonly (string | null)[];
    currencies: readonly {
      currency: CurrencyCode;
      balances: readonly { name: string | null; amountMinor: number }[];
      transfers: readonly { from: string | null; to: string | null; amountMinor: number }[];
    }[];
  }): Html =>
    joinHtml(
      [
        html`Делим поровну на: ${names.map((n) => n ?? DELETED_MEMBER).join(', ')}`,
        ...(currencies.length === 0
          ? [html`Все в расчёте.`]
          : currencies.map(({ currency, balances, transfers }) =>
              joinHtml(
                [
                  html`<b>${currency}</b>`,
                  ...balances.map(
                    (b) =>
                      html`${b.name ?? DELETED_MEMBER}: ${b.amountMinor > 0 ? '+' : ''}${formatMoney({ amountMinor: b.amountMinor, currency })}`,
                  ),
                  ...transfers.map(
                    (t) =>
                      html`${t.from ?? DELETED_MEMBER} → ${t.to ?? DELETED_MEMBER}: ${formatMoney({ amountMinor: t.amountMinor, currency })}`,
                  ),
                ],
                '\n',
              ),
            )),
      ],
      '\n\n',
    ),
  settleEven: html`Все в расчёте.`,
  settleTransferButton: (from: string | null, to: string | null): string =>
    `Перевёл: ${from ?? DELETED_MEMBER} → ${to ?? DELETED_MEMBER}`,
  settleJoinButton: 'Я тоже участвую',
  settleJoinedToast: 'Вы участвуете в расчёте',
  settleAlreadyJoined: 'Вы уже участвуете',
  settleNotParty: 'Отметить перевод может только тот, кто платит, или тот, кто получает',
  transferRecorded: ({
    from,
    to,
    money,
  }: {
    from: string | null;
    to: string | null;
    money: Money;
  }): Html =>
    html`Записан перевод: ${from ?? DELETED_MEMBER} → ${to ?? DELETED_MEMBER}, ${formatMoney(money)}.`,
  transferDeleted: html`Перевод удалён. Пересчитать: /settle`,
  transferDeletedToast: 'Перевод удалён',
  transferAlreadyDeleted: 'Перевод уже удалён',
  transferNotFound: 'Перевод не найден',
  // The operation, then the person's balance in its currency after it.
  debtRecorded: ({ kind, money, balance }: DebtRecordedView): Html =>
    joinHtml(
      [html`Записано: ${DEBT_KIND_LABELS[kind]} ${formatMoney(money)}.`, debtLine(balance)],
      '\n',
    ),

  periodPrev: (period: PeriodRef): string => `◀ ${periodLabel(period)}`,
  periodNext: (period: PeriodRef): string => `${periodLabel(period)} ▶`,

  // Donations in Telegram Stars (ADR-0027): a donation unlocks nothing.
  donate: html`Бот бесплатный для всех и таким останется: платных функций нет. Пожертвование ничего не открывает, оно помогает оплачивать сервер. Если хотите поддержать, выберите сумму:`,
  donateUnavailable: html`Пожертвования временно недоступны.`,
  donateStarsButton: (stars: number): string => `⭐ ${stars}`,
  // The invoice behind each Stars button: title at most 32 characters, description at most 255.
  // Plain text.
  donateInvoiceTitle: 'Поддержать бота',
  donateInvoiceDescription:
    'Пожертвование на оплату сервера. Бот остаётся бесплатным, пожертвование ничего не открывает.',
  donateInvoiceLabel: 'Пожертвование',
  // Shown by Telegram on the payment sheet when the pre-checkout is refused. Plain text.
  donateRejected: 'Эта сумма больше не принимается. Откройте /donate заново.',
  donateThanks: html`Спасибо! Бот остаётся бесплатным для всех.`,
  // The button to DONATE_URL, after the Stars buttons.
  donateExternal: 'Ko-fi',
  // The private help's last line.
  helpDonateLine,
  // To the admin, once per recorded donation. No Telegram name or username.
  adminDonation: ({
    stars,
    userId,
    chargeId,
  }: {
    stars: number;
    userId: string;
    chargeId: string;
  }): Html =>
    joinHtml(
      [
        html`⭐ Пожертвование: ${stars} Stars`,
        html`Пользователь: <code>${userId}</code>`,
        html`Платёж: <code>${chargeId}</code>`,
      ],
      '\n',
    ),

  // /paysupport, which Telegram requires of a bot taking payments.
  paySupport: html`Пожертвование ничего не открывает: бот одинаково бесплатный для всех. Чтобы попросить вернуть пожертвование, отправьте /paysupport и текст просьбы одним сообщением, например: «/paysupport верните, пожалуйста, пожертвование».`,
  paySupportSent: html`Просьба передана. Ответ придёт в этот чат.`,
  // To the admin: the request, the user's internal id and their newest donations. `on` is the
  // donation's date in the admin's timezone. The text is user text.
  adminPaySupport: ({
    userId,
    text,
    donations,
  }: {
    userId: string;
    text: string;
    donations: readonly { chargeId: string; stars: number; on: LocalDate; refunded: boolean }[];
  }): Html =>
    joinHtml(
      [
        html`💬 /paysupport от <code>${userId}</code>`,
        html`${text}`,
        donations.length === 0
          ? html`Пожертвований нет.`
          : joinHtml(
              [
                html`Пожертвования:`,
                ...donations.map(
                  (d) =>
                    html`<code>${d.chargeId}</code> · ${d.stars} Stars · ${dayMonth.format(new Date(`${d.on}T00:00:00Z`))} ${d.on.slice(0, 4)}${d.refunded ? ' · возвращено' : ''}`,
                ),
              ],
              '\n',
            ),
      ],
      '\n\n',
    ),
  // The admin's /refund <charge id>.
  refundUsage: html`Укажите платёж: /refund и его id из уведомления о пожертвовании.`,
  refundDone: (stars: number): Html => html`Возвращено: ${stars} Stars.`,
  refundNotFound: html`Пожертвование с таким id не найдено.`,
  refundAlreadyRefunded: html`Это пожертвование уже возвращено.`,
  refundFailed: (reason: string): Html =>
    html`Telegram не вернул Stars: ${reason}. Пожертвование не отмечено возвращённым.`,

  versionAnnouncements,
  // The message the admin gets at boot on a new version.
  versionAnnouncement: (version: string, body: Html): Html =>
    joinHtml([html`🆕 Версия ${version}`, body, html`Все изменения: /changelog`], '\n\n'),
  // /changelog: the CHANGELOG_RECENT newest versions, by number, then a link to the rest.
  changelog: (announcements: Readonly<Record<string, Html>>): Html => {
    const entries = Object.entries(announcements)
      .sort(([a], [b]) => compareVersions(b, a))
      .map(([version, body]) => joinHtml([html`<b>${version}</b>`, body], '\n'));
    const parts = [html`<b>Что нового</b>`, ...entries.slice(0, CHANGELOG_RECENT)];
    if (entries.length > CHANGELOG_RECENT)
      parts.push(html`Более ранние версии: <a href="${CHANGELOG_URL}">CHANGELOG.md</a>`);
    return joinHtml(parts, '\n\n');
  },
} as const;
