import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { Ledger, LedgerId } from '../../db/ledgers.js';
import type { User } from '../../db/users.js';
import { CURRENCY_CODES, toCurrencyCode } from '../../domain/currencies.js';
import { TIMEZONES, timezoneBySlug } from '../../domain/timezones.js';
import {
  setAnchor,
  type BudgetScreen,
  type CategoriesScreen,
  type SettingsScreen,
} from '../../services/flowSessions.js';
import {
  encryptionState,
  startEnableFlow,
  startPassphraseChange,
} from '../../services/ledgerKeys.js';
import { activeLedgerCategories } from '../../services/manageCategories.js';
import {
  screenSettings,
  setLedgerCurrency,
  setLedgerTimezone,
  startTimezoneFlow,
  updateTimezone,
  type SettingsView,
} from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import {
  CURRENCY_PICKER,
  SET_CURRENCY,
  SET_TIMEZONE,
  SETTINGS_BUDGET,
  SETTINGS_CATEGORIES,
  SETTINGS_ENCRYPTION,
  SETTINGS_OPEN,
  SETTINGS_PASSPHRASE,
  TIMEZONE_OTHER,
  TIMEZONE_PAGE,
  TIMEZONE_PICKER,
  setCurrencyData,
  setTimezoneData,
  timezonePageData,
} from '../callbackData.js';
import { messages } from '../messages.js';
import { pageOf, pagerRow } from '../nav.js';
import { joinHtml, type Html } from '../render/html.js';
import {
  backRow,
  cancelRow,
  renderAnchor,
  requireScreen,
  showScreen,
  type ScreenTap,
  type ScreenView,
} from '../screens.js';
import { budgetView } from './budget.js';
import { categoriesView } from './categories.js';
import { ensureUser } from './start.js';

// The /settings hub (ADR-0011): the user's timezone and the active ledger's default currency,
// each changed in place in the anchor, and a way into the categories screen. [Другой…] asks for
// an IANA name through a text flow (ADR-0009); flows.ts takes the answer.
// Scoped to a shared ledger (the anchor's `ledgerId`, opened from the group's /settings deep
// link), the same hub and pickers set that ledger's timezone and currency, for its owner only.

// Undefined when the screen is scoped to a ledger the user doesn't own.
export function settingsView(
  deps: HandlerDeps,
  user: User,
  ledgerId?: LedgerId,
): ScreenView | undefined {
  const settings = screenSettings(deps, user, ledgerId);
  if (settings === undefined) return undefined;
  const pickers = [
    InlineKeyboard.text(messages.timezoneButton, TIMEZONE_PICKER),
    InlineKeyboard.text(messages.currencyButton, CURRENCY_PICKER),
  ];
  return ledgerId === undefined
    ? {
        text: messages.settingsScreen(settings),
        markup: InlineKeyboard.from([
          pickers,
          [InlineKeyboard.text(messages.settingsCategoriesButton, SETTINGS_CATEGORIES)],
          [InlineKeyboard.text(messages.settingsEncryptionButton, SETTINGS_ENCRYPTION)],
        ]),
      }
    : {
        text: messages.ledgerSettingsScreen(settings),
        markup: InlineKeyboard.from([
          pickers,
          [InlineKeyboard.text(messages.settingsBudgetButton, SETTINGS_BUDGET)],
        ]),
      };
}

// Opens the hub scoped to a shared ledger the user owns. False when they don't own it.
export async function sendLedgerSettings(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
  ledgerId: LedgerId,
): Promise<boolean> {
  const view = settingsView(deps, user, ledgerId);
  if (view === undefined) return false;
  await showScreen(ctx, deps, user, { name: 'settings', ledgerId }, view);
  return true;
}

// The city list two per row, the current zone marked, then the pager, [Другой…] and [« Назад].
function timezonePickerView(timezone: string, page: number): ScreenView {
  const shown = pageOf(TIMEZONES, page);
  const choices = shown.items.map((entry) => {
    const label = messages.cityButton(entry.slug);
    return InlineKeyboard.text(
      entry.iana === timezone ? messages.currentChoice(label) : label,
      setTimezoneData(entry.slug),
    );
  });
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < choices.length; i += 2) rows.push(choices.slice(i, i + 2));
  const pager = pagerRow(shown, timezonePageData);
  if (pager.length > 0) rows.push(pager);
  rows.push([InlineKeyboard.text(messages.otherTimezoneButton, TIMEZONE_OTHER)]);
  rows.push(backRow(SETTINGS_OPEN));
  return { text: messages.timezonePicker(timezone), markup: InlineKeyboard.from(rows) };
}

// Every code of the currency table four per row, the current one marked, then [« Назад].
function currencyPickerView(ledger: Ledger): ScreenView {
  const choices = CURRENCY_CODES.map((code) =>
    InlineKeyboard.text(
      code === ledger.defaultCurrency ? messages.currentChoice(code) : code,
      setCurrencyData(code),
    ),
  );
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < choices.length; i += 4) rows.push(choices.slice(i, i + 4));
  rows.push(backRow(SETTINGS_OPEN));
  return { text: messages.currencyPicker({ ledger }), markup: InlineKeyboard.from(rows) };
}

// The [Другой…] prompt, with a refusal line above it when an answer failed.
export function timezonePromptView(timezone: string, refusal?: Html): ScreenView {
  const prompt = messages.timezonePrompt(timezone);
  return {
    text: refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The enable prompt (ADR-0020), with a refusal line above it when an answer failed.
export function encryptionPromptView(refusal?: Html): ScreenView {
  return {
    text:
      refusal === undefined
        ? messages.encryptionEnablePrompt
        : joinHtml([refusal, messages.encryptionEnablePrompt], '\n\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

// The sealed personal ledger's state, with [Сменить пароль] while unlocked; undefined while
// encryption is off.
export function encryptionView(deps: HandlerDeps, user: User): ScreenView | undefined {
  const state = encryptionState(deps, user);
  if (state.kind === 'off') return undefined;
  return {
    text: messages.encryptionScreen(state.kind),
    markup: InlineKeyboard.from([
      ...(state.kind === 'unlocked'
        ? [[InlineKeyboard.text(messages.changePassphraseButton, SETTINGS_PASSPHRASE)]]
        : []),
      backRow(SETTINGS_OPEN),
    ]),
  };
}

// The new-passphrase prompt, with a refusal line above it when an answer failed.
export function passphrasePromptView(refusal?: Html): ScreenView {
  return {
    text:
      refusal === undefined
        ? messages.changePassphrasePrompt
        : joinHtml([refusal, messages.changePassphrasePrompt], '\n\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

export async function sendSettings(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  const view = settingsView(deps, user);
  if (view === undefined) throw new Error('the personal settings view always exists');
  await showScreen(ctx, deps, user, { name: 'settings' }, view);
}

// The personal hub edited into the tapped message, which becomes the anchor: the setup check's
// [Изменить] (ADR-0028). A repeat tap re-renders the same hub.
export async function showSettingsInPlace(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
): Promise<void> {
  const tapped = ctx.callbackQuery?.message;
  if (tapped === undefined) return;
  const view = settingsView(deps, user);
  if (view === undefined) throw new Error('the personal settings view always exists');
  const anchor = {
    chatId: tapped.chat.id,
    messageId: tapped.message_id,
    screen: { name: 'settings' } as const,
  };
  setAnchor(deps, user, anchor);
  await renderAnchor(ctx, anchor, view);
}

interface SettingsTap extends ScreenTap {
  // The ledger the hub is scoped to; undefined for the user's own settings.
  readonly ledgerId: LedgerId | undefined;
  readonly settings: SettingsView;
}

// A settings callback on an anchor that shows another screen, or scoped to a ledger the user no
// longer owns, is stale.
async function settingsTap(ctx: Context, deps: HandlerDeps): Promise<SettingsTap | undefined> {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  const { screen } = tap.anchor;
  const settings =
    screen.name === 'settings' ? screenSettings(deps, tap.user, screen.ledgerId) : undefined;
  if (screen.name !== 'settings' || settings === undefined) {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return { ...tap, ledgerId: screen.ledgerId, settings };
}

// The hub for the tap's scope, after a change.
function hubView(deps: HandlerDeps, tap: SettingsTap, user: User = tap.user): ScreenView {
  const view = settingsView(deps, user, tap.ledgerId);
  if (view === undefined) throw new Error('settings scope vanished mid-tap');
  return view;
}

export function registerSettings(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('settings', (ctx) => sendSettings(ctx, deps));

  // Back to the hub from its pickers, and from the categories or budget screen it opened. A
  // scoped hub keeps its ledger; only a scoped hub opens a budget screen.
  bot.callbackQuery(SETTINGS_OPEN, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const from = tap.anchor.screen;
    const screen: SettingsScreen =
      from.name === 'settings'
        ? from
        : from.name === 'budget'
          ? { name: 'settings', ledgerId: from.ledgerId }
          : { name: 'settings' };
    const view = settingsView(deps, tap.user, screen.ledgerId);
    if (view === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const anchor = { ...tap.anchor, screen };
    setAnchor(deps, tap.user, anchor);
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, anchor, view);
  });

  bot.callbackQuery(SETTINGS_CATEGORIES, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    const view = activeLedgerCategories(deps, tap.user);
    const screen: CategoriesScreen = {
      name: 'categories',
      ledgerId: view.ledger.id,
      fromSettings: true,
    };
    const anchor = { ...tap.anchor, screen };
    setAnchor(deps, tap.user, anchor);
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, anchor, categoriesView(view, screen));
  });

  // The personal hub's [Шифрование]: the sealed ledger's state, or the enable prompt.
  bot.callbackQuery(SETTINGS_ENCRYPTION, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    if (tap.ledgerId !== undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const sealed = encryptionView(deps, tap.user);
    await ctx.answerCallbackQuery();
    if (sealed !== undefined) {
      await renderAnchor(ctx, tap.anchor, sealed);
      return;
    }
    startEnableFlow(deps, tap.user, deps.now());
    await renderAnchor(ctx, tap.anchor, encryptionPromptView());
  });

  // [Сменить пароль] on the unlocked ledger's encryption screen.
  bot.callbackQuery(SETTINGS_PASSPHRASE, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    switch (startPassphraseChange(deps, tap.user, deps.now())) {
      case 'asked':
        await ctx.answerCallbackQuery();
        await renderAnchor(ctx, tap.anchor, passphrasePromptView());
        return;
      case 'locked':
        await ctx.answerCallbackQuery({ text: messages.ledgerLockedToast });
        return;
      case 'off':
        await ctx.answerCallbackQuery({ text: messages.staleScreen });
        return;
    }
  });

  // The scoped hub's [Бюджет]: the same budget screen, acting on the hub's ledger. Only its owner
  // gets past budgetView; anyone else gets the not-owner toast.
  bot.callbackQuery(SETTINGS_BUDGET, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const { screen } = tap.anchor;
    if (screen.name !== 'settings' || screen.ledgerId === undefined) {
      await ctx.answerCallbackQuery({ text: messages.staleScreen });
      return;
    }
    const budget: BudgetScreen = { name: 'budget', ledgerId: screen.ledgerId, fromSettings: true };
    const view = budgetView(deps, tap.user, budget);
    if (view === undefined) {
      await ctx.answerCallbackQuery({ text: messages.budgetNotOwnerToast });
      return;
    }
    const anchor = { ...tap.anchor, screen: budget };
    setAnchor(deps, tap.user, anchor);
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, anchor, view);
  });

  bot.callbackQuery(TIMEZONE_PAGE, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    await ctx.answerCallbackQuery();
    const { timezone } = tap.settings;
    await renderAnchor(ctx, tap.anchor, timezonePickerView(timezone, Number(ctx.match[1] ?? 1)));
  });

  bot.callbackQuery(SET_TIMEZONE, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    // A slug no longer in the list: answered silently by the dispatcher, nothing written.
    const entry = timezoneBySlug(ctx.match[1] ?? '');
    if (entry === undefined) return;
    const { user, ledgerId } = tap;
    const result =
      ledgerId === undefined
        ? updateTimezone(deps, { user, timezone: entry.iana })
        : setLedgerTimezone(deps, { user, ledgerId, timezone: entry.iana });
    switch (result.kind) {
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.staleScreen });
        return;
      case 'unchanged':
        await ctx.answerCallbackQuery({ text: messages.timezoneUnchanged });
        return;
      case 'updated':
        await ctx.answerCallbackQuery({ text: messages.timezoneChangedToast });
        await renderAnchor(ctx, tap.anchor, hubView(deps, tap, { ...user, timezone: entry.iana }));
        return;
    }
  });

  bot.callbackQuery(CURRENCY_PICKER, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, currencyPickerView(tap.settings.ledger));
  });

  bot.callbackQuery(SET_CURRENCY, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    // A code not in the table: answered silently by the dispatcher, nothing written.
    const currency = toCurrencyCode(ctx.match[1] ?? '');
    if (currency === undefined) return;
    const result = setLedgerCurrency(deps, { user: tap.user, currency, ledgerId: tap.ledgerId });
    switch (result.kind) {
      case 'forbidden':
        await ctx.answerCallbackQuery({ text: messages.currencyForbidden(result.ledger) });
        return;
      case 'unchanged':
        await ctx.answerCallbackQuery({ text: messages.currencyUnchanged });
        return;
      case 'updated':
        await ctx.answerCallbackQuery({ text: messages.currencyChangedToast });
        await renderAnchor(ctx, tap.anchor, hubView(deps, tap));
        return;
    }
  });

  bot.callbackQuery(TIMEZONE_OTHER, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    startTimezoneFlow(deps, tap.user, deps.now(), tap.ledgerId);
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, timezonePromptView(tap.settings.timezone));
  });
}
