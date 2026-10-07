import type { Composer, Context } from 'grammy';
import { decodeReceiptUrl } from '../../domain/receipts/index.js';
import type { AdminDeps } from '../bot.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { answerReceipt } from './receipt.js';
import { ensureUser } from './start.js';

// Telegram caps sendData at 4096 bytes. Longer data is refused here rather than trusted to that.
const MAX_SCAN_BYTES = 4096;

// The Mini App's scan (ADR-0025): the QR text the page sent with sendData runs the pasted-link
// path, so a repeat scan of one receipt is caught by the receipt's identity (ADR-0018). Anything
// else gets one reply and records nothing. The scanned text is never logged.
export function registerWebAppData(bot: Composer<Context>, deps: AdminDeps): void {
  bot.on('message:web_app_data', async (ctx) => {
    const { data } = ctx.message.web_app_data;
    const decoded =
      new TextEncoder().encode(data).length > MAX_SCAN_BYTES ? undefined : decodeReceiptUrl(data);
    if (decoded === undefined || decoded.kind === 'notReceipt') {
      await replyHtml(ctx, messages.scanNotReceipt);
      return;
    }
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    // Telegram dates are Unix seconds.
    await answerReceipt(ctx, deps, {
      user,
      decoded,
      occurredAt: new Date(ctx.message.date * 1000),
      now,
    });
  });
}
