import type { Composer, Context } from 'grammy';
import type { HandlerDeps } from '../bot.js';
import { messages } from '../messages.js';
import { sendHelp } from './help.js';
import { sendToday } from './today.js';

// A menu tap arrives as plain text. Only an exact label is a tap: `Сегодня` or `📊 Сегодня!`
// falls through to the expense parser. Register before the text handler.
export function registerMenu(bot: Composer<Context>, deps: HandlerDeps): void {
  const routes = new Map<string, (ctx: Context) => Promise<void>>([
    [messages.menu.today, (ctx) => sendToday(ctx, deps)],
    [messages.menu.help, sendHelp],
  ]);
  bot.on('message:text', async (ctx, next) => {
    const route = routes.get(ctx.message.text);
    if (route === undefined) {
      await next();
      return;
    }
    await route(ctx);
  });
}
