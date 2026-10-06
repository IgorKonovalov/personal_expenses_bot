import type { Composer, Context } from 'grammy';
import { isExportRange } from '../../domain/export/rows.js';
import { exportGroupLedger } from '../../services/exportLedger.js';
import { boundLedger } from '../../services/groupChats.js';
import { EXPORT_BACK, EXPORT_FORMAT, EXPORT_RANGE } from '../callbackData.js';
import { createTapGuard } from '../callbacks.js';
import { rangeStep, sendExport, showFormatStep, showRangeStep } from '../handlers/export.js';
import { replyHtml } from '../render/html.js';
import type { GroupHandlerDeps } from './index.js';
import { fromPerson } from './text.js';

// /export in a bound group: the same picker on the group's ledger, read through the chat's
// binding, so any member may tap and the files go to the group. Stateless like the summary
// pager; an unbound chat answers nothing.
export function registerGroupExport(group: Composer<Context>, deps: GroupHandlerDeps): void {
  const guard = createTapGuard();

  group.command('export', async (ctx) => {
    if (ctx.message === undefined || !fromPerson(ctx.message)) return;
    if (boundLedger(deps, ctx.chat.id) === undefined) return;
    const step = rangeStep(false);
    await replyHtml(ctx, step.text, { reply_markup: step.markup });
  });

  group.callbackQuery(EXPORT_RANGE, (ctx) => showFormatStep(ctx, ctx.match[1] ?? ''));
  group.callbackQuery(EXPORT_BACK, (ctx) => showRangeStep(ctx, false));

  group.callbackQuery(EXPORT_FORMAT, async (ctx) => {
    const range = ctx.match[1] ?? '';
    const format = ctx.match[2] === 'xlsx' ? 'xlsx' : 'csv';
    const chatId = ctx.chat?.id;
    if (!isExportRange(range) || chatId === undefined) return;
    await guard(ctx, async () => {
      const data = exportGroupLedger(deps, { chatId, range, now: deps.now() });
      // An unbound chat is answered silently by the dispatcher.
      if (data === undefined) return;
      await sendExport(ctx, deps, data, range, format);
    });
  });
}
