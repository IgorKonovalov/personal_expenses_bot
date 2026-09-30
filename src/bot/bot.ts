import { Bot, type MiddlewareFn } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Db } from '../db/connection.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { Logger } from '../logger.js';
import { callbackAnswered, callbackDispatcher } from './callbacks.js';
import { clearFlowOnCommand } from './flows.js';
import { registerCancel } from './handlers/cancel.js';
import { registerCard } from './handlers/card.js';
import { registerCategories } from './handlers/categories.js';
import { registerCategory } from './handlers/category.js';
import { registerHelp } from './handlers/help.js';
import { registerMenu } from './handlers/menu.js';
import { registerEdited, registerNonText, registerUnknownCommand } from './handlers/other.js';
import { registerSettings } from './handlers/settings.js';
import { registerStart } from './handlers/start.js';
import { registerSummary } from './handlers/summary.js';
import { registerText } from './handlers/text.js';
import { registerToday } from './handlers/today.js';
import { messages } from './messages.js';
import { allowlist } from './middleware/allowlist.js';
import { replyHtml } from './render/html.js';

export interface HandlerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly defaultTimezone: string;
  readonly defaultCurrency: CurrencyCode;
}

export interface BotOptions extends HandlerDeps {
  readonly token: string;
  readonly allowedTelegramIds: ReadonlySet<number>;
  // Skips the getMe call at startup; tests pass a fixed identity.
  readonly botInfo?: UserFromGetMe;
}

export function createBot(options: BotOptions): Bot {
  const { logger } = options;
  const bot = new Bot(
    options.token,
    options.botInfo === undefined ? {} : { botInfo: options.botInfo },
  );

  // Registered first so it wraps every later middleware, including handlers added after
  // createBot returns. bot.catch only sees errors under bot.start(), not handleUpdate().
  bot.use(errorBoundary(logger));
  bot.use(allowlist(options.allowedTelegramIds, logger));
  // Answer-once tracking for every callback query, and the silent fallback answer for one no
  // handler claimed. The fallback runs after the whole chain, so it never swallows a scope.
  bot.use(callbackDispatcher());
  // A command or menu tap clears a pending text flow (ADR-0009) before its handler runs.
  bot.use(clearFlowOnCommand(options));

  // Commands and exact menu labels first: the text handler treats any other text as a flow
  // answer or an expense attempt, and whatever isn't text gets the help reply.
  registerStart(bot, options);
  registerToday(bot, options);
  registerSummary(bot, options);
  registerCategories(bot, options);
  registerSettings(bot, options);
  registerCancel(bot, options);
  registerHelp(bot);
  registerUnknownCommand(bot);
  registerMenu(bot, options);
  registerCard(bot, options);
  registerCategory(bot, options);
  registerText(bot, options);
  registerNonText(bot);
  registerEdited(bot, options);

  bot.catch((err) => {
    logger.error(
      { updateId: err.ctx.update.update_id, err: safeError(err.error) },
      'error escaped the error boundary',
    );
  });

  return bot;
}

// The slash-command list the client shows. A failure costs only that list, so boot continues.
export async function registerCommands(bot: Bot, logger: Logger): Promise<void> {
  try {
    await bot.api.setMyCommands(messages.commands);
  } catch (error) {
    logger.warn({ err: safeError(error) }, 'setMyCommands failed');
  }
}

function errorBoundary(logger: Logger): MiddlewareFn {
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      logger.error({ updateId: ctx.update.update_id, err: safeError(error) }, 'handler failed');
      try {
        if (ctx.callbackQuery !== undefined && !callbackAnswered(ctx)) {
          await ctx.answerCallbackQuery();
        }
        if (ctx.chat !== undefined) await replyHtml(ctx, messages.genericError);
      } catch (replyError) {
        logger.error(
          { updateId: ctx.update.update_id, err: safeError(replyError) },
          'apology reply failed',
        );
      }
    }
  };
}

// Name, message and stack only. pino's default serializer copies every enumerable property,
// and a GrammyError carries the request payload, i.e. the text the bot was sending.
function safeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { name: error.name, message: error.message }
      : { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'NonError', message: typeof error };
}
