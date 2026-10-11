import { InlineKeyboard, type Composer, type Context } from 'grammy';
import { seenNotice } from '../../services/notices.js';
import { isOnboarded } from '../../services/onboarding.js';
import type { HandlerDeps } from '../bot.js';
import {
  HELP_OPEN,
  HELP_TOPIC,
  HELP_TOPICS,
  helpOpenData,
  helpTopicData,
  moreData,
  type HelpTopic,
} from '../callbackData.js';
import { withMenuBack } from '../keyboards.js';
import { DOCS_URL, messages } from '../messages.js';
import { editHtml, replyHtml, sendTransient } from '../render/html.js';
import type { ScreenView } from '../screens.js';
import { ensureUser } from './start.js';

// /help (ADR-0050): a short core with a button per topic, the guide and what's new. A topic is
// edited into the same message with [« Назад] to the help screen. Every tap is stateless; one
// from a help screen the hub opened carries the hub mark, so [« Назад] to the hub survives.

// The topic buttons two per row, [Руководство], [Что нового], and [« Назад] to the hub when the
// screen was opened from it.
export function helpView(fromMenu: boolean): ScreenView {
  const topics = HELP_TOPICS.map((topic) =>
    InlineKeyboard.text(messages.helpTopicButtons[topic], helpTopicData(topic, fromMenu)),
  );
  const rows = [];
  for (let i = 0; i < topics.length; i += 2) rows.push(topics.slice(i, i + 2));
  return withMenuBack(
    {
      text: messages.helpCore,
      markup: InlineKeyboard.from([
        ...rows,
        [InlineKeyboard.url(messages.helpDocsButton, DOCS_URL)],
        [InlineKeyboard.text(messages.moreButtons.changelog, moreData('chg'))],
      ]),
    },
    fromMenu,
  );
}

function topicView(topic: HelpTopic, fromMenu: boolean): ScreenView {
  return {
    text: messages.helpTopics[topic],
    markup: InlineKeyboard.from([
      [InlineKeyboard.text(messages.backButton, helpOpenData(fromMenu))],
    ]),
  };
}

// /help, the old [❓ Помощь] label and a first stray message: the help screen as a new message.
// It carries no reply keyboard: only /start restores the bar.
export async function sendHelp(ctx: Context): Promise<void> {
  const view = helpView(false);
  await replyHtml(ctx, view.text, { reply_markup: view.markup });
}

// Input the bot can't read (an unknown command, text that isn't an expense, a sticker): the help
// screen the first time (ADR-0037), then a one-line pointer to it that deletes itself. A
// never-onboarded user gets nothing here: the welcome and setup check that follow stand in for
// it, and the welcome points to /help, so the help counts as seen.
export async function sendStrayReply(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  if (!isOnboarded(deps, user)) {
    seenNotice(deps, user, 'stray_help', now);
    return;
  }
  if (seenNotice(deps, user, 'stray_help', now)) {
    await sendHelp(ctx);
    return;
  }
  await sendTransient(ctx, messages.notUnderstood, (error) => {
    deps.logger.warn(
      { updateId: ctx.update.update_id, err: error instanceof Error ? error.name : typeof error },
      'transient reply delete failed',
    );
  });
}

export function registerHelp(bot: Composer<Context>): void {
  bot.command('help', (ctx) => sendHelp(ctx));

  bot.callbackQuery(HELP_TOPIC, async (ctx) => {
    const topic = HELP_TOPICS.find((t) => t === ctx.match[1]);
    if (topic === undefined) return;
    const view = topicView(topic, ctx.match[2] !== undefined);
    await ctx.answerCallbackQuery();
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(HELP_OPEN, async (ctx) => {
    const view = helpView(ctx.match[1] !== undefined);
    await ctx.answerCallbackQuery();
    await editHtml(ctx, view.text, { reply_markup: view.markup });
  });
}
