import { InlineKeyboard, Keyboard, type Context } from 'grammy';
import { MENU_OPEN } from './callbackData.js';
import { messages } from './messages.js';
import type { Screen } from '../services/flowSessions.js';
import type { ScreenView } from './screens.js';

// The persistent menu bar (ADR-0011, ADR-0050): two rows of three. It rides on the /start and
// /help replies only: a message can't carry both a reply keyboard and an inline one, and Telegram
// keeps showing it afterwards. With `webappUrl`, the second row holds «📷 Скан», a `web_app` button opening the
// Mini App in scan mode: only a page opened from a reply-keyboard button can call sendData
// (ADR-0025).
export function menuKeyboard(webappUrl?: string): Keyboard {
  const keyboard = new Keyboard()
    .text(messages.menu.today)
    .text(messages.menu.week)
    .text(messages.menu.month)
    .row()
    .text(messages.menu.budget);
  if (webappUrl !== undefined) keyboard.webApp(messages.scanButton, `${webappUrl}#m=scan`);
  return keyboard.text(messages.menu.more).resized().persistent();
}

// The menu for this chat: `web_app` buttons work only in private chats, so a group never gets one.
export function menuKeyboardFor(ctx: Context, webappUrl: string | undefined): Keyboard {
  return menuKeyboard(ctx.chat?.type === 'private' ? webappUrl : undefined);
}

// What a hub button opens in the tapped message: the view, and the screen the message becomes
// the anchor of (none for a stateless screen, which keeps its hub mark in its callback data).
export interface MenuOpened {
  readonly view: ScreenView;
  readonly screen?: Screen;
  // The view links a page whose preview card would crowd it out.
  readonly noPreview?: true;
}

// A screen opened from the [☰ Меню] hub: [« Назад] to the hub alone on its bottom row. The hub
// holds no state, so the button works on any message.
export function withMenuBack(view: ScreenView, fromMenu: boolean | undefined): ScreenView {
  if (fromMenu !== true) return view;
  return {
    text: view.text,
    markup: InlineKeyboard.from([
      ...view.markup.inline_keyboard,
      [InlineKeyboard.text(messages.backButton, MENU_OPEN)],
    ]),
  };
}
