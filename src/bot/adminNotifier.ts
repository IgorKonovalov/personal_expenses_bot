import type { Api } from 'grammy';
import { sendHtml, type Html } from './render/html.js';

// Messages from the bot itself to the admin, ADMIN_TELEGRAM_ID (ADR-0013).
// Rejects when Telegram refuses, e.g. 403 until the admin has pressed /start.
export function adminNotifier(api: Api, adminId: number): (body: Html) => Promise<void> {
  return async (body) => {
    await sendHtml(api, adminId, body);
  };
}
