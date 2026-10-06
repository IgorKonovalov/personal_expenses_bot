import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import { isLocked, type Locked } from '../../services/ledgerKeys.js';
import { activePeriodItems } from '../../services/periodItems.js';
import { todaySummary } from '../../services/todaySummary.js';
import type { HandlerDeps } from '../bot.js';
import { dayItemsData } from '../callbackData.js';
import { messages } from '../messages.js';
import { replyHtml, type Html } from '../render/html.js';
import { offerTip } from '../tips.js';
import { ensureUser } from './start.js';

export interface TodayReply {
  readonly text: Html;
  // [Позиции] for the day, absent when its receipts list no items.
  readonly markup?: InlineKeyboard;
}

// The active ledger's today, with [Позиции] when the viewer's receipts of the day list items
// (ADR-0038). A locked sealed ledger reads as `locked`.
export function todayReply(deps: HandlerDeps, user: User, now: Date): TodayReply | Locked {
  const summary = todaySummary(deps, { user, now });
  if ('kind' in summary) return summary;
  const text = messages.today(summary);
  const day = { from: summary.date, to: summary.date };
  const items = activePeriodItems(deps, { user, range: day });
  if (isLocked(items) || items.groups.length === 0) return { text };
  return {
    text,
    markup: new InlineKeyboard().text(messages.periodItemsButton, dayItemsData(summary.date, 1)),
  };
}

// Shared by /today and the 📊 menu button.
export async function sendToday(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  const reply = todayReply(deps, user, now);
  if (isLocked(reply)) {
    await replyHtml(ctx, messages.ledgerLocked);
    return;
  }
  await replyHtml(
    ctx,
    reply.text,
    reply.markup === undefined ? {} : { reply_markup: reply.markup },
  );
  await offerTip(ctx, deps, user, 'todayShown');
}

export function registerToday(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('today', (ctx) => sendToday(ctx, deps));
}
