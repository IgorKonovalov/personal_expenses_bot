import { Keyboard } from 'grammy';
import { messages } from './messages.js';

// The persistent menu bar (ADR-0011). It rides on the /start and help replies only: a message
// can't carry both a reply keyboard and an inline one, and Telegram keeps showing it afterwards.
export function menuKeyboard(): Keyboard {
  return new Keyboard()
    .text(messages.menu.today)
    .text(messages.menu.week)
    .text(messages.menu.month)
    .row()
    .text(messages.menu.settings)
    .text(messages.menu.help)
    .resized()
    .persistent();
}
