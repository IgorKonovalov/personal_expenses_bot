import { Keyboard, type Context } from 'grammy';
import { messages } from './messages.js';

// The persistent menu bar (ADR-0011). It rides on the /start and help replies only: a message
// can't carry both a reply keyboard and an inline one, and Telegram keeps showing it afterwards.
// With `webappUrl`, the first row ends in «📷 Скан», a `web_app` button opening the Mini App in
// scan mode: only a page opened from a reply-keyboard button can call sendData (ADR-0025).
export function menuKeyboard(webappUrl?: string): Keyboard {
  const keyboard = new Keyboard()
    .text(messages.menu.today)
    .text(messages.menu.week)
    .text(messages.menu.month);
  if (webappUrl !== undefined) keyboard.webApp(messages.scanButton, `${webappUrl}#m=scan`);
  return keyboard
    .row()
    .text(messages.menu.budget)
    .text(messages.menu.settings)
    .text(messages.menu.help)
    .text(messages.menu.more)
    .resized()
    .persistent();
}

// The menu for this chat: `web_app` buttons work only in private chats, so a group never gets one.
export function menuKeyboardFor(ctx: Context, webappUrl: string | undefined): Keyboard {
  return menuKeyboard(ctx.chat?.type === 'private' ? webappUrl : undefined);
}
