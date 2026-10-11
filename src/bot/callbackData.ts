import type { CategoryId } from '../db/categories.js';
import type { ExpenseId } from '../db/expenses.js';
import type { RuleId } from '../db/recurring.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { ExportRange } from '../domain/export/rows.js';
import { periodKey, type Period } from '../domain/periods.js';
import type { LocalDate } from '../domain/time.js';

// Telegram rejects callback_data over 64 bytes (UTF-8). Format: `<scope>:<action>[:<arg>…]`,
// built only here (ADR-0011).
const MAX_CALLBACK_DATA_BYTES = 64;

export function assertCallbackData(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data is ${bytes} bytes; Telegram allows ${MAX_CALLBACK_DATA_BYTES}`);
  }
  return data;
}

// Expense-card actions work on any card, however old: the expense's stored state is the guard.
export const UNDO_EXPENSE = /^exp:undo:([0-9a-f-]{36})$/;
export const RESTORE_EXPENSE = /^exp:restore:([0-9a-f-]{36})$/;

export function undoExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:undo:${expenseId}`);
}

// The group card's [Удалить] and [Вернуть] (ADR-0014): `grp:del:<uuid>` / `grp:res:<uuid>`
// (44 bytes). Only the expense's author gets past the service's check.
export const GROUP_DELETE = /^grp:del:([0-9a-f-]{36})$/;
export const GROUP_RESTORE = /^grp:res:([0-9a-f-]{36})$/;

export function groupDeleteData(expenseId: ExpenseId): string {
  return assertCallbackData(`grp:del:${expenseId}`);
}

export function groupRestoreData(expenseId: ExpenseId): string {
  return assertCallbackData(`grp:res:${expenseId}`);
}

// The question to an amount-last group message (ADR-0046): [Записать] `gask:ok:<messageId>`,
// [Не трата] `gask:no:<messageId>` (at most 18 bytes). The chat comes from the update; the
// question's stored row is the guard.
export const GROUP_ASK = /^gask:(ok|no):(\d{1,10})$/;

export function groupAskData(action: 'ok' | 'no', messageId: number): string {
  return assertCallbackData(`gask:${action}:${messageId}`);
}

// A reading of an ambiguous amount: `amb:t` thousands, `amb:d` decimal. The amount itself isn't
// in the data; the tap re-parses the message the question replies to.
export const AMBIGUOUS_READING = /^amb:([td])$/;

export function ambiguousReadingData(interpretation: 'thousands' | 'decimal'): string {
  return assertCallbackData(`amb:${interpretation === 'thousands' ? 't' : 'd'}`);
}

export function restoreExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:restore:${expenseId}`);
}

// The category picker, edited into the card in place. Pages are 1-based. A category id is a
// short integer (ADR-0007), so `exp:setcat:<uuid>:<id>` fits for ids of up to 16 digits.
export const CATEGORY_PICKER = /^exp:cat:([0-9a-f-]{36})$/;
export const CATEGORY_PAGE = /^exp:catp:([0-9a-f-]{36}):(\d{1,4})$/;
export const SET_CATEGORY = /^exp:setcat:([0-9a-f-]{36}):(\d{1,16})$/;
export const SHOW_EXPENSE = /^exp:show:([0-9a-f-]{36})$/;

export function categoryPickerData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:cat:${expenseId}`);
}

export function categoryPageData(expenseId: ExpenseId, page: number): string {
  return assertCallbackData(`exp:catp:${expenseId}:${page}`);
}

export function setCategoryData(expenseId: ExpenseId, categoryId: CategoryId): string {
  return assertCallbackData(`exp:setcat:${expenseId}:${categoryId}`);
}

export function showExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:show:${expenseId}`);
}

// The edit flow on the card: [Изменить] `exp:edit:<uuid>` (45 bytes) opens the field picker,
// `exp:ef:<uuid>:<a|d|t|g>` (45 bytes) picks amount, description, date or tags, and a date quick
// button `exp:dt:<uuid>:<YYYY-MM-DD>` (54 bytes) carries the absolute date it sets.
export const EDIT_EXPENSE = /^exp:edit:([0-9a-f-]{36})$/;
export const EDIT_FIELD = /^exp:ef:([0-9a-f-]{36}):([adtg])$/;
export const SET_EXPENSE_DATE = /^exp:dt:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

export type EditField = 'a' | 'd' | 't' | 'g';

export function editExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:edit:${expenseId}`);
}

export function editFieldData(expenseId: ExpenseId, field: EditField): string {
  return assertCallbackData(`exp:ef:${expenseId}:${field}`);
}

export function setExpenseDateData(expenseId: ExpenseId, date: LocalDate): string {
  return assertCallbackData(`exp:dt:${expenseId}:${date}`);
}

// A receipt card's [Позиции] `exp:items:<uuid>:<page>` (at most 51 bytes), its 1-based item page,
// and [Повторить] `exp:rcretry:<uuid>` (48 bytes), which refetches a failed receipt (ADR-0018).
export const RECEIPT_ITEMS = /^exp:items:([0-9a-f-]{36}):(\d{1,4})$/;
export const RECEIPT_RETRY = /^exp:rcretry:([0-9a-f-]{36})$/;

export function receiptItemsData(expenseId: ExpenseId, page: number): string {
  return assertCallbackData(`exp:items:${expenseId}:${page}`);
}

export function receiptRetryData(expenseId: ExpenseId): string {
  return assertCallbackData(`exp:rcretry:${expenseId}`);
}

// The /categories screen (ADR-0011). Only the current screen anchor accepts these.
export const CATEGORIES_OPEN = 'cat:open';
export const CATEGORY_ADD = 'cat:add';
// `cat:ren` / `cat:arc` open page 1 of their picker; `cat:renp:<page>` / `cat:arcp:<page>` page
// it; `cat:ren:<id>` / `cat:arc:<id>` pick.
export const CATEGORY_RENAME_PAGE = /^cat:ren(?:p:(\d{1,4}))?$/;
export const CATEGORY_RENAME = /^cat:ren:(\d{1,16})$/;
export const CATEGORY_ARCHIVE_PAGE = /^cat:arc(?:p:(\d{1,4}))?$/;
export const CATEGORY_ARCHIVE = /^cat:arc:(\d{1,16})$/;

export type CategoryAction = 'ren' | 'arc';

export function categoryActionData(action: CategoryAction): string {
  return assertCallbackData(`cat:${action}`);
}

export function categoryActionPageData(action: CategoryAction, page: number): string {
  return assertCallbackData(`cat:${action}p:${page}`);
}

export function categoryActionPickData(action: CategoryAction, categoryId: CategoryId): string {
  return assertCallbackData(`cat:${action}:${categoryId}`);
}

// The essential-category picker (ADR-0017), under the budget's Что считать: `cat:ess` opens page
// 1, `cat:essp:<page>` pages it, and `cat:ess:<id>:<0|1>` sets the value it carries (at most 26
// bytes). It is a set, not a toggle, so a double tap converges. Only a budget anchor accepts
// these.
export const CATEGORY_ESSENTIAL_OPEN = 'cat:ess';
export const CATEGORY_ESSENTIAL_PAGE = /^cat:ess(?:p:(\d{1,4}))?$/;
export const SET_CATEGORY_ESSENTIAL = /^cat:ess:(\d{1,16}):([01])$/;

export function categoryEssentialPageData(page: number): string {
  return assertCallbackData(`cat:essp:${page}`);
}

export function setCategoryEssentialData(categoryId: CategoryId, essential: boolean): string {
  return assertCallbackData(`cat:ess:${categoryId}:${essential ? 1 : 0}`);
}

// The setup check on first contact (ADR-0028): [Да, всё верно] `onb:ok` confirms it in place,
// [Изменить] `onb:edit` turns it into the settings hub. Both act on the tapped message only.
export const ONBOARDING_OK = 'onb:ok';
export const ONBOARDING_EDIT = 'onb:edit';

// [Отключить подсказки] under a tip (ADR-0028): switches tips off, a set-to-value, so a second
// tap changes nothing more.
export const TIPS_OFF = 'tip:off';

// The /settings hub (ADR-0011). `set:open` shows the hub in the anchor, from any of its pickers
// and from the categories or budget screen it opened.
export const SETTINGS_OPEN = 'set:open';
export const SETTINGS_CATEGORIES = 'set:cat';
// The hub scoped to a shared ledger opens that ledger's /budget screen in the anchor.
export const SETTINGS_BUDGET = 'set:bud';
// The personal hub's [Уведомления] and [Аккаунт и данные] (ADR-0050): the switches, and the
// encryption, privacy and deletion screen. On the latter, [Приватность] `set:prv` and [Удалить
// аккаунт] `set:del` show the policy and the delete prompt in the anchor.
export const SETTINGS_NOTIFICATIONS = 'set:ntf';
export const SETTINGS_ACCOUNT = 'set:acc';
export const SETTINGS_PRIVACY = 'set:prv';
export const SETTINGS_DELETE = 'set:del';
// [Шифрование] on Аккаунт и данные (ADR-0020): the enable prompt, or the sealed ledger's state.
export const SETTINGS_ENCRYPTION = 'set:enc';
// [Сменить пароль] on that screen, while the ledger is unlocked.
export const SETTINGS_PASSPHRASE = 'set:encpw';
// [Сохранил] under the recovery code message deletes that message.
export const RECOVERY_SAVED = 'enc:saved';
// [Подсказки: вкл/выкл] on Уведомления (ADR-0028): flips the tips switch and re-renders.
export const SETTINGS_TIPS = 'set:tips';
// [Убирать мои сообщения: вкл/выкл] on Уведомления (ADR-0038): flips the tidy chat switch and
// re-renders.
export const SETTINGS_TIDY = 'set:tidy';
// [Итоги месяца: вкл/выкл] and [Итоги недели: вкл/выкл] on Уведомления: flip the summary push
// switch and re-render.
export const SETTINGS_PUSH_MONTHLY = 'set:pm';
export const SETTINGS_PUSH_WEEKLY = 'set:pw';
// `set:cur` opens the currency picker, `set:cur:<CODE>` picks (11 bytes).
export const CURRENCY_PICKER = 'set:cur';
export const SET_CURRENCY = /^set:cur:([A-Z]{3})$/;

export function setCurrencyData(currency: CurrencyCode): string {
  return assertCallbackData(`set:cur:${currency}`);
}
// `set:tz` opens page 1 of the city list, `set:tzp:<page>` pages it, `set:tz:<slug>` picks.
export const TIMEZONE_PICKER = 'set:tz';
export const TIMEZONE_PAGE = /^set:tz(?:p:(\d{1,4}))?$/;
export const SET_TIMEZONE = /^set:tz:([a-z0-9_-]{1,20})$/;
export const TIMEZONE_OTHER = 'set:tzother';

export function timezonePageData(page: number): string {
  return assertCallbackData(`set:tzp:${page}`);
}

export function setTimezoneData(slug: string): string {
  return assertCallbackData(`set:tz:${slug}`);
}

// The /week and /month period pager: `sum:m:<YYYY-MM>` (13 bytes), `sum:w:<Monday YYYY-MM-DD>`
// (16 bytes). The pattern only shapes the key; parsePeriod decides whether it names a period.
export const SUMMARY_PAGE = /^sum:([mw]):([0-9-]{1,10})$/;

export function summaryPageData(period: Period): string {
  return assertCallbackData(`sum:${period.kind === 'month' ? 'm' : 'w'}:${periodKey(period)}`);
}

// [Отключить] under a summary push: `sum:off:m` the monthly push, `sum:off:w` the weekly one
// (9 bytes). A set-to-value, so a second tap switches nothing more.
export const SUMMARY_PUSH_OFF = /^sum:off:([mw])$/;

export function summaryPushOffData(push: 'monthly' | 'weekly'): string {
  return assertCallbackData(`sum:off:${push === 'monthly' ? 'm' : 'w'}`);
}

// [Показать] under a locked ledger's push: `sum:show:<m|w>:<period key>`, the key `YYYY-MM`, a
// budget period's first day or a week's Monday (at most 21 bytes). The sent push's row is the
// guard.
export const SUMMARY_PUSH_SHOW = /^sum:show:([mw]):(\d{4}-\d{2}(?:-\d{2})?)$/;

export function summaryPushShowData(push: 'monthly' | 'weekly', periodKey: string): string {
  return assertCallbackData(`sum:show:${push === 'monthly' ? 'm' : 'w'}:${periodKey}`);
}

// [Позиции] on /week and /month and its pager (ADR-0038): `itm:w:<Monday YYYY-MM-DD>:<page>`,
// `itm:m:<YYYY-MM>:<page>`, 1-based pages (at most 19 bytes). They act on the summary screen's
// ledger, so only its anchor accepts them.
export const PERIOD_ITEMS = /^itm:([mw]):([0-9-]{1,10}):(\d{1,4})$/;

export function periodItemsData(period: Period, page: number): string {
  return assertCallbackData(
    `itm:${period.kind === 'month' ? 'm' : 'w'}:${periodKey(period)}:${page}`,
  );
}

// The summary's drill-down (Plan 0037), on the summary screen's ledger, so only its anchor accepts
// these. `drl:p:<m|w>:<key>:<page>` (at most 23 bytes) shows a page of the period's category
// picker; `drl:c:<m|w>:<key>:<categoryId|n>:<page>` (at most 40 bytes) a page of one category's
// expenses, `n` the uncategorized ones; `drl:e:<uuid>` (42 bytes) opens an expense's card in the
// anchor, and the card's `drl:back` returns to its list (ADR-0040).
export const DRILL_PICKER = /^drl:p:([mw]):([0-9-]{1,10}):(\d{1,4})$/;
export const DRILL_LIST = /^drl:c:([mw]):([0-9-]{1,10}):(\d{1,16}|n):(\d{1,4})$/;
export const DRILL_EXPENSE = /^drl:e:([0-9a-f-]{36})$/;
export const DRILL_BACK = 'drl:back';

export function drillPickerData(period: Period, page: number): string {
  return assertCallbackData(
    `drl:p:${period.kind === 'month' ? 'm' : 'w'}:${periodKey(period)}:${page}`,
  );
}

export function drillListData(period: Period, categoryId: CategoryId | null, page: number): string {
  return assertCallbackData(
    `drl:c:${period.kind === 'month' ? 'm' : 'w'}:${periodKey(period)}:${categoryId ?? 'n'}:${page}`,
  );
}

export function drillExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`drl:e:${expenseId}`);
}

// [Позиции] under /today: `itm:d:<YYYY-MM-DD>:<page>` (at most 21 bytes). It acts on the active
// ledger at tap time, on whichever message carries it.
export const DAY_ITEMS = /^itm:d:(\d{4}-\d{2}-\d{2}):(\d{1,4})$/;

export function dayItemsData(date: LocalDate, page: number): string {
  return assertCallbackData(`itm:d:${date}:${page}`);
}

// [« Назад] under /today's items and its day list: edits the message back into /today for the
// current day.
export const TODAY_SHOW = 'itm:today';

// [Траты] under /today and the day list's pager and day row (Plan 0048): `day:<YYYY-MM-DD>:<page>`
// (at most 19 bytes), a 1-based page of that day's expenses. It reads the active ledger at tap
// time and makes the tapped message the anchor, so it works on any copy of /today.
export const DAY_LIST = /^day:(\d{4}-\d{2}-\d{2}):(\d{1,4})$/;

export function dayListData(date: LocalDate, page: number): string {
  return assertCallbackData(`day:${date}:${page}`);
}

// The /budget screen (ADR-0017). Only the current screen anchor accepts these, and they act on
// the anchor's ledger, so none carries a ledger id. `bud:open` shows the read view in the anchor,
// `bud:cfg` its setup and `bud:what` the scope screen under it (ADR-0050); `bud:lim` asks for the
// limit, `bud:day` for the period start day.
export const BUDGET_OPEN = 'bud:open';
export const BUDGET_SETUP = 'bud:cfg';
export const BUDGET_WHAT = 'bud:what';
export const BUDGET_LIMIT = 'bud:lim';
export const BUDGET_START_DAY = 'bud:day';
// `bud:scope:a` counts every expense, `bud:scope:o` only optional ones: the scope it sets.
export const BUDGET_SCOPE = /^bud:scope:([ao])$/;

export function budgetScopeData(scope: 'all' | 'optional'): string {
  return assertCallbackData(`bud:scope:${scope === 'all' ? 'a' : 'o'}`);
}
// The category cap list: `bud:caps` opens page 1 and `bud:caps:p:<page>` pages it;
// `bud:cap:<id>` asks for a category's cap and `bud:capx:<id>` clears it (at most 25 bytes).
export const BUDGET_CAPS_OPEN = 'bud:caps';
export const BUDGET_CAPS = /^bud:caps(?::p:(\d{1,4}))?$/;
export const BUDGET_CAP = /^bud:cap:(\d{1,16})$/;
export const BUDGET_CAP_CLEAR = /^bud:capx:(\d{1,16})$/;

export function budgetCapsPageData(page: number): string {
  return assertCallbackData(`bud:caps:p:${page}`);
}

export function budgetCapData(categoryId: CategoryId): string {
  return assertCallbackData(`bud:cap:${categoryId}`);
}

export function budgetCapClearData(categoryId: CategoryId): string {
  return assertCallbackData(`bud:capx:${categoryId}`);
}

// The admin's /invites list: [Отключить] `inv:off:<code>` (19 bytes) revokes that code
// (ADR-0024). The code's revoked_at is the guard, so a double tap finds it already off.
export const INVITE_REVOKE = /^inv:off:([A-Za-z0-9_-]{11})$/;

export function inviteRevokeData(code: string): string {
  return assertCallbackData(`inv:off:${code}`);
}

// /delete_account's [Удалить всё] and [Отмена] (ADR-0024). The user's tombstone is the guard: a
// second [Удалить всё] finds no account behind the Telegram id.
export const ACCOUNT_DELETE = 'acct:del';
export const ACCOUNT_KEEP = 'acct:keep';

// [Отмена] on a text prompt (ADR-0009).
export const FLOW_CANCEL = 'flow:cancel';

// A bank statement's preview (Plan 0027): [Записать все] `stm:all`, [Записать и уже записанные]
// `stm:dup` and [Отмена] `stm:x`. They act on the statement the user's flow session holds, so
// none carries an id.
export const STATEMENT_RECORD_ALL = 'stm:all';
export const STATEMENT_RECORD_WITH_MATCHED = 'stm:dup';
// The preview's 1-based row page: `stm:p:<page>` (at most 10 bytes).
export const STATEMENT_PAGE = /^stm:p:(\d{1,4})$/;

export function statementPageData(page: number): string {
  return assertCallbackData(`stm:p:${page}`);
}
export const STATEMENT_CANCEL = 'stm:x';

// A group history import (ADR-0047). Every button carries the user's chat_imports row's 6-char
// base-36 nonce, so a button from an earlier upload never acts on a later one: [Записать N трат]
// `imp:rec:<n>`, [Проверить (N)] `imp:rev:<n>`, [Закончить проверку] `imp:end:<n>`, [Отмена]
// `imp:x:<n>`, and [Отменить импорт] `imp:undo:<n>` with its [Да, удалить] `imp:undoy:<n>` and
// [Нет] `imp:undon:<n>` (at most 16 bytes).
const NONCE = '([0-9a-z]{6})';
export const CHAT_IMPORT_RECORD = new RegExp(`^imp:rec:${NONCE}$`);
export const CHAT_IMPORT_CANCEL = new RegExp(`^imp:x:${NONCE}$`);
export const CHAT_IMPORT_REVIEW = new RegExp(`^imp:rev:${NONCE}$`);
export const CHAT_IMPORT_FINISH = new RegExp(`^imp:end:${NONCE}$`);
export const CHAT_IMPORT_UNDO = new RegExp(`^imp:undo:${NONCE}$`);
export const CHAT_IMPORT_UNDO_YES = new RegExp(`^imp:undoy:${NONCE}$`);
export const CHAT_IMPORT_UNDO_NO = new RegExp(`^imp:undon:${NONCE}$`);

export function chatImportData(
  action: 'rec' | 'x' | 'rev' | 'end' | 'undo' | 'undoy' | 'undon',
  nonce: string,
): string {
  return assertCallbackData(`imp:${action}:${nonce}`);
}

// The preview's ready list pager: `imp:pg:<n>:<page>`, 1-based (at most 18 bytes).
export const CHAT_IMPORT_PAGE = new RegExp(`^imp:pg:${NONCE}:(\\d{1,4})$`);

export function chatImportPageData(nonce: string, page: number): string {
  return assertCallbackData(`imp:pg:${nonce}:${page}`);
}

// A review card's buttons, on the message at index `<i>` of the import (at most 5 digits):
// [Записать так] `imp:ok`, [Исправить] `imp:fix`, [« Назад к карточке] `imp:back`, [Пропустить]
// `imp:skip` and [👤] `imp:who` (at most 21 bytes); a reading of an ambiguous amount
// `imp:rd:<n>:<i>:<r>`.
export type ChatImportCardAction = 'ok' | 'fix' | 'back' | 'skip' | 'who';
export const CHAT_IMPORT_CARD = new RegExp(`^imp:(ok|fix|back|skip|who):${NONCE}:(\\d{1,5})$`);
export const CHAT_IMPORT_READING = new RegExp(`^imp:rd:${NONCE}:(\\d{1,5}):(\\d)$`);

export function chatImportCardData(
  action: ChatImportCardAction,
  nonce: string,
  index: number,
): string {
  return assertCallbackData(`imp:${action}:${nonce}:${index}`);
}

export function chatImportReadingData(nonce: string, index: number, reading: number): string {
  return assertCallbackData(`imp:rd:${nonce}:${index}:${reading}`);
}

// An answer to a name prefix's question: `imp:map:<n>:<prefixIndex>:<senderIndex|a|x>`, a sender
// of the import, [Автор сообщения] `a` or [Это не имя] `x` (at most 21 bytes).
export const CHAT_IMPORT_PREFIX = new RegExp(`^imp:map:${NONCE}:(\\d{1,4}):(\\d{1,4}|a|x)$`);

export function chatImportPrefixData(
  nonce: string,
  prefixIndex: number,
  answer: number | 'a' | 'x',
): string {
  return assertCallbackData(`imp:map:${nonce}:${prefixIndex}:${answer}`);
}

// Recurring expenses (Plan 0025). [Повторять] on a card `rec:new:<uuid>` (44 bytes) offers the
// schedules from the expense's date; `rec:s:<uuid>:<m|w|y>` (44 bytes) makes the rule on one:
// monthly, weekly or yearly.
export const REPEAT_EXPENSE = /^rec:new:([0-9a-f-]{36})$/;
export const REPEAT_SCHEDULE = /^rec:s:([0-9a-f-]{36}):([mwy])$/;

export function repeatExpenseData(expenseId: ExpenseId): string {
  return assertCallbackData(`rec:new:${expenseId}`);
}

export function repeatScheduleData(expenseId: ExpenseId, choice: 'm' | 'w' | 'y'): string {
  return assertCallbackData(`rec:s:${expenseId}:${choice}`);
}

// The /recurring screen (ADR-0011). Only the current anchor accepts these. `rec:list` shows the
// list, `rec:r:<uuid>` (42 bytes) a rule's screen; `rec:mode:<a|k>` sets the mode it names on the
// anchor's rule (auto or ask), `rec:del` asks to delete it and `rec:delok` deletes it.
export const RECURRING_LIST = 'rec:list';
export const RULE_OPEN = /^rec:r:([0-9a-f-]{36})$/;
export const RULE_MODE = /^rec:mode:([ak])$/;
export const RULE_DELETE = 'rec:del';
export const RULE_DELETE_CONFIRM = 'rec:delok';

// [Добавить напоминание] `rec:rem` asks for the text; `rec:rs:<m|w|y>` picks the schedule from
// today for the text the anchor holds. [Записать трату] under a reminder is `rec:rx`.
export const REMINDER_ADD = 'rec:rem';
export const REMINDER_SCHEDULE = /^rec:rs:([mwy])$/;
export const REMINDER_EXPENSE = 'rec:rx';

export function reminderScheduleData(choice: 'm' | 'w' | 'y'): string {
  return assertCallbackData(`rec:rs:${choice}`);
}

export function ruleOpenData(ruleId: RuleId): string {
  return assertCallbackData(`rec:r:${ruleId}`);
}

export function ruleModeData(mode: 'auto' | 'ask'): string {
  return assertCallbackData(`rec:mode:${mode === 'auto' ? 'a' : 'k'}`);
}

// An `ask` occurrence's prompt: [Записать] `rec:ok:<uuid>:<YYYY-MM-DD>` (54 bytes), [Другая
// сумма] `rec:amt:…` (55) and [Пропустить] `rec:skip:…` (56). They work on any prompt, however
// old: the occurrence's stored outcome is the guard.
export const ASK_RECORD = /^rec:ok:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;
export const ASK_AMOUNT = /^rec:amt:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;
export const ASK_SKIP = /^rec:skip:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

export type AskAction = 'ok' | 'amt' | 'skip';

export function askData(action: AskAction, ruleId: RuleId, dueOn: LocalDate): string {
  return assertCallbackData(`rec:${action}:${ruleId}:${dueOn}`);
}

// The /debts screen (Plan 0013). Only the current anchor accepts these. `dbt:new:<l|b>` asks for
// a loan's amount, lent or borrowed; the person picker's `dbt:pick:<id>` picks a known person
// for the pending flow, and `dbt:pp:<page>` pages it (at most 25 bytes).
export const DEBT_NEW = /^dbt:new:([lb])$/;
export const DEBT_PICK = /^dbt:pick:(\d{1,16})$/;
export const DEBT_PAGE = /^dbt:pp:(\d{1,4})$/;

export function debtNewData(direction: 'lend' | 'borrow'): string {
  return assertCallbackData(`dbt:new:${direction === 'lend' ? 'l' : 'b'}`);
}

export function debtPickData(personId: number): string {
  return assertCallbackData(`dbt:pick:${personId}`);
}

export function debtPageData(page: number): string {
  return assertCallbackData(`dbt:pp:${page}`);
}

// A person's card: `dbt:p:<id>` opens it, `dbt:list` goes back to the list. [Мне вернули] /
// [Я вернул] are `dbt:rp:<id>:<t|i>`; with several balances that way, `dbt:rc:<id>:<CUR>` picks
// the currency (at most 26 bytes). [Весь долг] `dbt:all` repays the pending repayment's whole
// balance.
export const DEBTS_LIST = 'dbt:list';
export const DEBT_PERSON = /^dbt:p:(\d{1,16})$/;
export const DEBT_REPAY = /^dbt:rp:(\d{1,16}):([ti])$/;
export const DEBT_REPAY_CURRENCY = /^dbt:rc:(\d{1,16}):([A-Z]{3})$/;
export const DEBT_REPAY_ALL = 'dbt:all';

export function debtPersonData(personId: number): string {
  return assertCallbackData(`dbt:p:${personId}`);
}

export function debtRepayData(personId: number, direction: 'toMe' | 'byMe'): string {
  return assertCallbackData(`dbt:rp:${personId}:${direction === 'toMe' ? 't' : 'i'}`);
}

export function debtRepayCurrencyData(personId: number, currency: CurrencyCode): string {
  return assertCallbackData(`dbt:rc:${personId}:${currency}`);
}

// The split picker after a `/N` expense, in its anchor: `dbt:sp:<id>` toggles a person (at most
// 23 bytes), [Готово] `dbt:spok` records the debts, [Пропустить] `dbt:spx` records none.
export const SPLIT_TOGGLE = /^dbt:sp:(\d{1,16})$/;
export const SPLIT_DONE = 'dbt:spok';
export const SPLIT_SKIP = 'dbt:spx';

export function splitToggleData(personId: number): string {
  return assertCallbackData(`dbt:sp:${personId}`);
}

// [Удалить] on a debt operation's confirmation: `dbt:del:<uuid>` (44 bytes). It works on any
// confirmation, however old: the operation's stored state is the guard.
export const DEBT_DELETE = /^dbt:del:([0-9a-f-]{36})$/;

export function debtDeleteData(opId: string): string {
  return assertCallbackData(`dbt:del:${opId}`);
}

// /settle in a group (Plan 0013). [Перевёл] `stl:t:<i>:<8 hex>` (at most 17 bytes) records
// transfer i of the list whose hash it carries; [Я тоже участвую] is `stl:join`; [Удалить]
// under a recorded transfer is `stl:del:<uuid>` (44 bytes).
export const SETTLE_TRANSFER = /^stl:t:(\d{1,2}):([0-9a-f]{8})$/;
export const SETTLE_JOIN = 'stl:join';
export const SETTLE_DELETE = /^stl:del:([0-9a-f-]{36})$/;

export function settleTransferData(index: number, hash: string): string {
  return assertCallbackData(`stl:t:${index}:${hash}`);
}

export function settleDeleteData(transferId: string): string {
  return assertCallbackData(`stl:del:${transferId}`);
}

// /tags (ADR-0029): `tag:l:<page>` (at most 12 bytes with the hub mark) shows a 1-based page of
// the list. It reads the viewer's ledger at tap time, so it carries no ledger id.
export const TAG_LIST_PAGE = /^tag:l:(\d{1,4})(:m)?$/;

export function tagListPageData(page: number, fromMenu = false): string {
  return marked(`tag:l:${page}`, fromMenu);
}

// A tag's button on /tags: `tag:s:<8 hex>` (16 bytes with the hub mark), the tagHash of its
// name, which the tap resolves against the ledger's tags at that moment.
export const TAG_SHOW = /^tag:s:([0-9a-f]{8})(:m)?$/;

export function tagShowData(hash: string, fromMenu = false): string {
  return marked(`tag:s:${hash}`, fromMenu);
}

// [Постоянная метка] on the private /tags screen: asks for the sticky tag, as /tag <name> sets it.
export const STICKY_TAG_ASK = 'tag:sticky';

// /prices (ADR-0039). Only the current anchor accepts these, and they act on the anchor's
// ledger. `prc:p:<page>` shows a 1-based page of the products (at most 10 bytes); `prc:o:<ref>`
// opens one product, a ref being `b:<catalog key of at most 24 ASCII characters>` or
// `u:<integer>` (at most 32 bytes).
export const PRICES_PAGE = /^prc:p:(\d{1,4})$/;
export const PRODUCT_OPEN = /^prc:o:(b:[a-z0-9_]{1,24}|u:\d{1,16})$/;

export function pricesPageData(page: number): string {
  return assertCallbackData(`prc:p:${page}`);
}

export function productOpenData(ref: string): string {
  return assertCallbackData(`prc:o:${ref}`);
}

// The review of item names, against the names the anchor holds: [Разобрать] `prc:rv` starts it
// on the unmatched names, and an answer `prc:r:<position>:<ref|n|s>` (at most 40 bytes) gives the
// name at that position a product, "not a product" (`n`), or skips it (`s`). The position makes a
// double tap answer the same name again. `prc:rp:<page>` pages the product picker.
export const PRICES_REVIEW = 'prc:rv';
export const REVIEW_ANSWER = /^prc:r:(\d{1,4}):(n|s|b:[a-z0-9_]{1,24}|u:\d{1,16})$/;
export const REVIEW_PAGE = /^prc:rp:(\d{1,4})$/;

export function reviewAnswerData(position: number, choice: string): string {
  return assertCallbackData(`prc:r:${position}:${choice}`);
}

export function reviewPageData(page: number): string {
  return assertCallbackData(`prc:rp:${page}`);
}

// [Новый продукт] in the picker `prc:new` asks for a name; once it is typed, `prc:u:<unit>`
// (at most 10 bytes) creates the product with that unit for the name under review.
export const PRODUCT_NEW = 'prc:new';
export const PRODUCT_UNIT = /^prc:u:(l|kg|pcs)$/;

export function productUnitData(unit: 'l' | 'kg' | 'pcs'): string {
  return assertCallbackData(`prc:u:${unit}`);
}

// [Названия] on a product `prc:nm:<ref>` lists the names counted under it into the anchor;
// `prc:np:<page>` pages that list and `prc:nn:<index>` opens the picker for one of them.
export const PRODUCT_NAMES = /^prc:nm:(b:[a-z0-9_]{1,24}|u:\d{1,16})$/;
export const NAMES_PAGE = /^prc:np:(\d{1,4})$/;
export const NAME_PICK = /^prc:nn:(\d{1,4})$/;

export function productNamesData(ref: string): string {
  return assertCallbackData(`prc:nm:${ref}`);
}

export function namesPageData(page: number): string {
  return assertCallbackData(`prc:np:${page}`);
}

export function namePickData(index: number): string {
  return assertCallbackData(`prc:nn:${index}`);
}

// [Снять метку] under /tag: clears the sticky tag of the viewer's active ledger. A set-to-value,
// so a second tap clears nothing more.
export const STICKY_TAG_OFF = 'tag:off';

// The /export picker: `xp:r:<range>` shows the format step, `xp:f:<range>:<format>` builds and
// sends (at most 15 bytes with the hub mark), `xp:back` returns to the range step. The ledger
// isn't in the data: the active ledger in a DM, the chat's binding in a group.
export const EXPORT_RANGE = /^xp:r:(tm|pm|ty|all)(:m)?$/;
export const EXPORT_FORMAT = /^xp:f:(tm|pm|ty|all):(csv|xlsx)(:m)?$/;
export const EXPORT_BACK = /^xp:back(:m)?$/;

export type ExportFormat = 'csv' | 'xlsx';

export function exportRangeData(range: ExportRange, fromMenu = false): string {
  return marked(`xp:r:${range}`, fromMenu);
}

export function exportFormatData(
  range: ExportRange,
  format: ExportFormat,
  fromMenu = false,
): string {
  return marked(`xp:f:${range}:${format}`, fromMenu);
}

export function exportBackData(fromMenu = false): string {
  return marked('xp:back', fromMenu);
}

// A [☰ Меню] hub button (ADR-0050): `more:<key>` (at most 10 bytes) opens the screen its key
// names in the tapped message. The hub is stateless, so a tap on any old copy works and carries
// nothing else. `more:open` redraws the hub itself: the [« Назад] of every screen it opened.
export const MORE_ACTION = /^more:([a-z]{2,5})$/;
export const MENU_OPEN = 'more:open';

export function moreData(key: string): string {
  return assertCallbackData(`more:${key}`);
}

// A stateless screen opened from the hub carries `:m` at the end of its own callback data, so
// its pager and steps keep the [« Назад] to the hub (2 bytes more).
function marked(data: string, fromMenu: boolean): string {
  return assertCallbackData(fromMenu ? `${data}:m` : data);
}

// The /help screen (ADR-0050): `help:<topic>` edits the tapped message into a topic, `help:open`
// back into the help screen (at most 16 bytes with the hub mark, `help:recurring:m`). Stateless:
// any copy works.
export const HELP_TOPICS = [
  'record',
  'receipts',
  'totals',
  'debts',
  'recurring',
  'groups',
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];
export const HELP_TOPIC = new RegExp(`^help:(${HELP_TOPICS.join('|')})(:m)?$`);
export const HELP_OPEN = /^help:open(:m)?$/;

export function helpTopicData(topic: HelpTopic, fromMenu: boolean): string {
  return marked(`help:${topic}`, fromMenu);
}

export function helpOpenData(fromMenu: boolean): string {
  return marked('help:open', fromMenu);
}

// The admin's buttons, behind the hub's [Админ]: `adm:<key>` (at most 9 bytes). Only the admin's
// taps run.
export const ADMIN_ACTION = /^adm:([a-z]{3,5})$/;

export function adminData(key: string): string {
  return assertCallbackData(`adm:${key}`);
}
