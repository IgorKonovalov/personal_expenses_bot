import type { CategoryId } from '../db/categories.js';
import type { ExpenseId } from '../db/expenses.js';
import type { CurrencyCode } from '../domain/currencies.js';
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
// `exp:ef:<uuid>:<a|d|t>` (45 bytes) picks amount, description or date, and a date quick button
// `exp:dt:<uuid>:<YYYY-MM-DD>` (54 bytes) carries the absolute date it sets.
export const EDIT_EXPENSE = /^exp:edit:([0-9a-f-]{36})$/;
export const EDIT_FIELD = /^exp:ef:([0-9a-f-]{36}):([adt])$/;
export const SET_EXPENSE_DATE = /^exp:dt:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

export type EditField = 'a' | 'd' | 't';

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

// The essential-category picker (ADR-0017): `cat:ess` opens page 1, `cat:essp:<page>` pages it,
// and `cat:ess:<id>:<0|1>` sets the value it carries (at most 26 bytes). It is a set, not a
// toggle, so a double tap converges.
export const CATEGORY_ESSENTIAL_OPEN = 'cat:ess';
export const CATEGORY_ESSENTIAL_PAGE = /^cat:ess(?:p:(\d{1,4}))?$/;
export const SET_CATEGORY_ESSENTIAL = /^cat:ess:(\d{1,16}):([01])$/;

export function categoryEssentialPageData(page: number): string {
  return assertCallbackData(`cat:essp:${page}`);
}

export function setCategoryEssentialData(categoryId: CategoryId, essential: boolean): string {
  return assertCallbackData(`cat:ess:${categoryId}:${essential ? 1 : 0}`);
}

// The /settings hub (ADR-0011). `set:open` shows the hub in the anchor, from any of its pickers
// and from the categories or budget screen it opened.
export const SETTINGS_OPEN = 'set:open';
export const SETTINGS_CATEGORIES = 'set:cat';
// The hub scoped to a shared ledger opens that ledger's /budget screen in the anchor.
export const SETTINGS_BUDGET = 'set:bud';
// The personal hub's [Шифрование] (ADR-0020): the enable prompt, or the sealed ledger's state.
export const SETTINGS_ENCRYPTION = 'set:enc';
// [Сменить пароль] on that screen, while the ledger is unlocked.
export const SETTINGS_PASSPHRASE = 'set:encpw';
// [Сохранил] under the recovery code message deletes that message.
export const RECOVERY_SAVED = 'enc:saved';
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

// The /budget screen (ADR-0017). Only the current screen anchor accepts these, and they act on
// the anchor's ledger, so none carries a ledger id. `bud:open` shows the screen in the anchor;
// `bud:lim` asks for the limit, `bud:day` for the period start day.
export const BUDGET_OPEN = 'bud:open';
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
