import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import { cancelFlow } from '../../services/flowSessions.js';
import { encryptionState } from '../../services/ledgerKeys.js';
import type { HandlerDeps } from '../bot.js';
import { MORE_ACTION, moreData } from '../callbackData.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { sendChangelog } from './changelog.js';
import { sendDebts } from './debts.js';
import { sendDeleteAccount } from './deleteAccount.js';
import { sendDonate, type DonateDeps } from './donate.js';
import { sendExportPicker } from './export.js';
import { sendPaySupport } from './paysupport.js';
import { sendPrivacy } from './privacy.js';
import { sendRecurring } from './recurring.js';
import { ensureUser } from './start.js';
import { sendTags } from './tags.js';
import { sendLock, sendUnlock } from './unlock.js';

// [☰ Ещё]: one inline button for every private command the menu bar lacks. Each button runs the
// function its command runs, so a tap answers exactly what the typed command answers.

export interface MoreDeps extends DonateDeps {
  readonly backupKeep: number;
  readonly adminTelegramId: number;
}

interface MoreButton {
  // The `more:<key>` callback data.
  readonly key: string;
  // The command the button stands for.
  readonly command: string;
  readonly label: string;
  readonly run: (ctx: Context, deps: MoreDeps) => Promise<void>;
}

const { moreButtons: label } = messages;

// In screen order, two per row.
const BUTTONS: readonly MoreButton[] = [
  { key: 'rec', command: 'recurring', label: label.recurring, run: sendRecurring },
  { key: 'debt', command: 'debts', label: label.debts, run: sendDebts },
  { key: 'tags', command: 'tags', label: label.tags, run: sendTags },
  { key: 'exp', command: 'export', label: label.export, run: sendExportPicker },
  { key: 'chg', command: 'changelog', label: label.changelog, run: (ctx) => sendChangelog(ctx) },
  { key: 'don', command: 'donate', label: label.donate, run: sendDonate },
  {
    key: 'pay',
    command: 'paysupport',
    label: label.paysupport,
    run: (ctx, deps) => sendPaySupport(ctx, deps, ''),
  },
  { key: 'prv', command: 'privacy', label: label.privacy, run: (ctx) => sendPrivacy(ctx) },
  {
    key: 'del',
    command: 'delete_account',
    label: label.deleteAccount,
    run: (ctx, deps) => sendDeleteAccount(ctx, deps.backupKeep),
  },
];

// Shown only for a sealed personal ledger: the one that changes its state.
const UNLOCK: MoreButton = { key: 'unl', command: 'unlock', label: label.unlock, run: sendUnlock };
const LOCK: MoreButton = { key: 'lock', command: 'lock', label: label.lock, run: sendLock };

const ALL = [...BUTTONS, UNLOCK, LOCK];

// Every more-screen button: its callback key and the command it runs.
export const MORE_BUTTONS: readonly { readonly key: string; readonly command: string }[] = ALL.map(
  ({ key, command }) => ({ key, command }),
);

function moreKeyboard(deps: HandlerDeps, user: User): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  BUTTONS.forEach((button, i) => {
    if (i > 0 && i % 2 === 0) keyboard.row();
    keyboard.text(button.label, moreData(button.key));
  });
  const encryption = encryptionState(deps, user).kind;
  if (encryption !== 'off') {
    const toggle = encryption === 'locked' ? UNLOCK : LOCK;
    keyboard.row().text(toggle.label, moreData(toggle.key));
  }
  return keyboard;
}

// The [☰ Ещё] tap: the screen as a new message. It holds no state, so any old copy still works.
export async function sendMore(ctx: Context, deps: HandlerDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  await replyHtml(ctx, messages.moreScreen, { reply_markup: moreKeyboard(deps, user) });
}

export function registerMore(bot: Composer<Context>, deps: MoreDeps): void {
  const byKey = new Map(ALL.map((b) => [b.key, b]));
  bot.callbackQuery(MORE_ACTION, async (ctx) => {
    const button = byKey.get(ctx.match[1] ?? '');
    if (button === undefined) return;
    await ctx.answerCallbackQuery();
    // As a typed command does: the pending flow is cleared before the command runs.
    cancelFlow(deps, ensureUser(deps, ctx.from.id, deps.now()));
    await button.run(ctx, deps);
  });
}
