import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { User } from '../../db/users.js';
import { TIMEZONES, timezoneBySlug } from '../../domain/timezones.js';
import { setAnchor, type CategoriesScreen } from '../../services/flowSessions.js';
import { activeLedgerCategories } from '../../services/manageCategories.js';
import { startTimezoneFlow, updateTimezone, userSettings } from '../../services/settings.js';
import type { HandlerDeps } from '../bot.js';
import {
  CURRENCY_PICKER,
  SET_TIMEZONE,
  SETTINGS_CATEGORIES,
  SETTINGS_OPEN,
  TIMEZONE_OTHER,
  TIMEZONE_PAGE,
  TIMEZONE_PICKER,
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
import { categoriesView } from './categories.js';
import { ensureUser } from './start.js';

// The /settings hub (ADR-0011): the user's timezone and the active ledger's default currency,
// each changed in place in the anchor, and a way into the categories screen. [Другой…] asks for
// an IANA name through a text flow (ADR-0009); flows.ts takes the answer.

export function settingsView(deps: HandlerDeps, user: User): ScreenView {
  return {
    text: messages.settingsScreen(userSettings(deps, user)),
    markup: InlineKeyboard.from([
      [
        InlineKeyboard.text(messages.timezoneButton, TIMEZONE_PICKER),
        InlineKeyboard.text(messages.currencyButton, CURRENCY_PICKER),
      ],
      [InlineKeyboard.text(messages.settingsCategoriesButton, SETTINGS_CATEGORIES)],
    ]),
  };
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

// The [Другой…] prompt, with a refusal line above it when an answer failed.
export function timezonePromptView(timezone: string, refusal?: Html): ScreenView {
  const prompt = messages.timezonePrompt(timezone);
  return {
    text: refusal === undefined ? prompt : joinHtml([refusal, prompt], '\n'),
    markup: InlineKeyboard.from([cancelRow()]),
  };
}

export async function sendSettings(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  await showScreen(ctx, deps, user, { name: 'settings' }, settingsView(deps, user));
}

// A settings callback on an anchor that shows another screen is stale.
async function settingsTap(ctx: Context, deps: HandlerDeps): Promise<ScreenTap | undefined> {
  const tap = await requireScreen(ctx, deps);
  if (tap === undefined) return undefined;
  if (tap.anchor.screen.name !== 'settings') {
    await ctx.answerCallbackQuery({ text: messages.staleScreen });
    return undefined;
  }
  return tap;
}

export function registerSettings(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('settings', (ctx) => sendSettings(ctx, deps));

  // Back to the hub from its pickers, and from the categories screen it opened.
  bot.callbackQuery(SETTINGS_OPEN, async (ctx) => {
    const tap = await requireScreen(ctx, deps);
    if (tap === undefined) return;
    const anchor = { ...tap.anchor, screen: { name: 'settings' } as const };
    setAnchor(deps, tap.user, anchor);
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, anchor, settingsView(deps, tap.user));
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

  bot.callbackQuery(TIMEZONE_PAGE, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    await ctx.answerCallbackQuery();
    const { timezone } = userSettings(deps, tap.user);
    await renderAnchor(ctx, tap.anchor, timezonePickerView(timezone, Number(ctx.match[1] ?? 1)));
  });

  bot.callbackQuery(SET_TIMEZONE, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    // A slug no longer in the list: answered silently by the dispatcher, nothing written.
    const entry = timezoneBySlug(ctx.match[1] ?? '');
    if (entry === undefined) return;
    const result = updateTimezone(deps, { user: tap.user, timezone: entry.iana });
    if (result.kind === 'unchanged') {
      await ctx.answerCallbackQuery({ text: messages.timezoneUnchanged });
      return;
    }
    await ctx.answerCallbackQuery({ text: messages.timezoneChangedToast });
    await renderAnchor(ctx, tap.anchor, settingsView(deps, { ...tap.user, timezone: entry.iana }));
  });

  bot.callbackQuery(TIMEZONE_OTHER, async (ctx) => {
    const tap = await settingsTap(ctx, deps);
    if (tap === undefined) return;
    const { timezone } = userSettings(deps, tap.user);
    startTimezoneFlow(deps, tap.user, deps.now());
    await ctx.answerCallbackQuery();
    await renderAnchor(ctx, tap.anchor, timezonePromptView(timezone));
  });
}
