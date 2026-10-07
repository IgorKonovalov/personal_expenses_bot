import type { Composer, Context } from 'grammy';
import type { AdminDeps } from '../bot.js';
import { messages } from '../messages.js';
import { sendBudget } from './budget.js';
import { sendHelp } from './help.js';
import { sendMore } from './more.js';
import { sendSettings } from './settings.js';
import { sendSummary } from './summary.js';
import { sendToday } from './today.js';

interface MenuRoute {
  readonly label: string;
  // The command the button stands for; [☰ Ещё] stands for none.
  readonly command?: string;
  readonly run: (ctx: Context, deps: AdminDeps) => Promise<void>;
}

const ROUTES: readonly MenuRoute[] = [
  { label: messages.menu.today, command: 'today', run: sendToday },
  {
    label: messages.menu.week,
    command: 'week',
    run: (ctx, deps) => sendSummary(ctx, deps, 'week'),
  },
  {
    label: messages.menu.month,
    command: 'month',
    run: (ctx, deps) => sendSummary(ctx, deps, 'month'),
  },
  { label: messages.menu.budget, command: 'budget', run: sendBudget },
  { label: messages.menu.settings, command: 'settings', run: sendSettings },
  { label: messages.menu.help, command: 'help', run: (ctx, deps) => sendHelp(ctx, deps.webappUrl) },
  { label: messages.menu.more, run: sendMore },
];

// Every command a menu-bar button runs.
export const MENU_BAR_COMMANDS: readonly string[] = ROUTES.flatMap((r) =>
  r.command === undefined ? [] : [r.command],
);

// A menu tap arrives as plain text. Only an exact label is a tap: `Сегодня` or `📊 Сегодня!`
// falls through to the expense parser. Register before the text handler.
export function registerMenu(bot: Composer<Context>, deps: AdminDeps): void {
  const routes = new Map(ROUTES.map((r) => [r.label, r.run]));
  bot.on('message:text', async (ctx, next) => {
    const route = routes.get(ctx.message.text);
    if (route === undefined) {
      await next();
      return;
    }
    await route(ctx, deps);
  });
}
