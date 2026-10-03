import { Bot, Composer, type Context, type MiddlewareFn } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Db } from '../db/connection.js';
import type { CurrencyCode } from '../domain/currencies.js';
import type { Logger } from '../logger.js';
import type { LedgerKeyring } from '../services/ledgerKeys.js';
import { callbackAnswered, callbackDispatcher } from './callbacks.js';
import { clearFlowOnCommand } from './flows.js';
import { groupComposer, isGroupChat } from './group/index.js';
import { registerAdmin } from './handlers/admin.js';
import { registerBudget } from './handlers/budget.js';
import { registerCancel } from './handlers/cancel.js';
import { registerCard } from './handlers/card.js';
import { registerCategories } from './handlers/categories.js';
import { registerCategory } from './handlers/category.js';
import { registerChangelog } from './handlers/changelog.js';
import { registerHelp } from './handlers/help.js';
import { registerInvite } from './handlers/invite.js';
import { registerMenu } from './handlers/menu.js';
import { registerEdited, registerNonText, registerUnknownCommand } from './handlers/other.js';
import { registerReceiptMedia, telegramFileDownloader } from './handlers/receipt.js';
import { registerSettings } from './handlers/settings.js';
import { registerStart } from './handlers/start.js';
import { registerSummary } from './handlers/summary.js';
import { registerText } from './handlers/text.js';
import { registerToday } from './handlers/today.js';
import { registerUnlock } from './handlers/unlock.js';
import { messages } from './messages.js';
import { access } from './middleware/access.js';
import { replyHtml } from './render/html.js';

export interface HandlerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly defaultTimezone: string;
  readonly defaultCurrency: CurrencyCode;
  // The process's unlocked sealed-ledger keys (ADR-0020), shared with every worker.
  readonly keys: LedgerKeyring;
}

// The handlers that check admission or serve the admin (ADR-0024).
export interface AdminDeps extends HandlerDeps {
  // Always admitted, and the only sender of the admin commands.
  readonly adminTelegramId: number;
}

export interface BotOptions extends AdminDeps {
  readonly token: string;
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

  // Group updates and everything else take separate composers (ADR-0014): no DM handler, flow
  // or anchor sees a group update, and the group side never falls through to the DM side.
  const dm = new Composer<Context>();
  bot.branch(isGroupChat, groupComposer(options), dm);

  dm.use(access(options));
  // Answer-once tracking for every callback query, and the silent fallback answer for one no
  // handler claimed. The fallback runs after the whole chain, so it never swallows a scope.
  dm.use(callbackDispatcher());
  // A command or menu tap clears a pending text flow (ADR-0009) before its handler runs.
  dm.use(clearFlowOnCommand(options));

  // Commands and exact menu labels first: the text handler treats any other text as a flow
  // answer, a receipt link or an expense attempt; photos and image files are read for a receipt
  // QR; whatever else isn't text gets the help reply.
  registerStart(dm, options);
  registerToday(dm, options);
  registerSummary(dm, options);
  registerCategories(dm, options);
  registerBudget(dm, options);
  registerSettings(dm, options);
  registerUnlock(dm, options);
  registerCancel(dm, options);
  registerHelp(dm);
  registerChangelog(dm);
  // Admin commands: from anyone else they fall through to the unknown-command reply.
  registerInvite(dm, options);
  registerAdmin(dm, options);
  registerUnknownCommand(dm);
  registerMenu(dm, options);
  registerCard(dm, options);
  registerCategory(dm, options);
  registerText(dm, options);
  registerReceiptMedia(dm, options, telegramFileDownloader(options.token));
  registerNonText(dm);
  registerEdited(dm, options);

  bot.catch((err) => {
    logger.error(
      { updateId: err.ctx.update.update_id, err: safeError(err.error) },
      'error escaped the error boundary',
    );
  });

  return bot;
}

// The slash-command lists the client shows: the DM list by default, the group list in every
// group (ADR-0014), plus the profile description texts. A failure costs only those, so boot
// continues.
export async function registerCommands(bot: Bot, logger: Logger): Promise<void> {
  try {
    await bot.api.setMyCommands(messages.commands);
    await bot.api.setMyCommands(messages.groupCommands, { scope: { type: 'all_group_chats' } });
  } catch (error) {
    logger.warn({ err: safeError(error) }, 'setMyCommands failed');
  }
  // The profile texts are overwritten on every boot, so editing them in messages ships with
  // the next deploy. A failure costs only the texts.
  try {
    await bot.api.setMyDescription(messages.botDescription);
    await bot.api.setMyShortDescription(messages.botShortDescription);
  } catch (error) {
    logger.warn({ err: safeError(error) }, 'setMyDescription failed');
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
