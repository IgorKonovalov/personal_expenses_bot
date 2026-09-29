import { Bot, type MiddlewareFn } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Logger } from '../logger.js';
import { messages } from './messages.js';
import { allowlist } from './middleware/allowlist.js';

export interface BotOptions {
  readonly token: string;
  readonly allowedTelegramIds: ReadonlySet<number>;
  readonly logger: Logger;
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

  bot.command('start', async (ctx) => {
    await ctx.reply(messages.welcome);
  });

  bot.catch((err) => {
    logger.error(
      { updateId: err.ctx.update.update_id, err: safeError(err.error) },
      'error escaped the error boundary',
    );
  });

  return bot;
}

function errorBoundary(logger: Logger): MiddlewareFn {
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      logger.error({ updateId: ctx.update.update_id, err: safeError(error) }, 'handler failed');
      try {
        if (ctx.callbackQuery !== undefined) await ctx.answerCallbackQuery();
        if (ctx.chat !== undefined) await ctx.reply(messages.genericError);
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
