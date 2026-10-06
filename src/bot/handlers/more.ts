import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { User } from '../../db/users.js';
import {
  cancelFlow,
  completeFlow,
  startFlow,
  type ArgCommand,
  type CommandArgFlow,
  type ScreenAnchor,
} from '../../services/flowSessions.js';
import { encryptionState } from '../../services/ledgerKeys.js';
import type { AdminDeps } from '../bot.js';
import { ADMIN_ACTION, MORE_ACTION, adminData, moreData } from '../callbackData.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { cancelRow, renderAnchor, showScreen } from '../screens.js';
import { sendBlock, sendStats } from './admin.js';
import { sendChangelog } from './changelog.js';
import { sendDebts } from './debts.js';
import { sendDeleteAccount } from './deleteAccount.js';
import { sendDonate, type DonateDeps } from './donate.js';
import { sendExportPicker } from './export.js';
import { sendInvite, sendInvites } from './invite.js';
import { sendPaySupport } from './paysupport.js';
import { sendPrices } from './prices.js';
import { sendPrivacy } from './privacy.js';
import { sendRecurring } from './recurring.js';
import { sendRefund } from './refund.js';
import { ensureUser } from './start.js';
import { sendTag, sendTags } from './tags.js';
import { sendLock, sendUnlock } from './unlock.js';

// [☰ Ещё]: one inline button for every private command the menu bar lacks. Each button runs the
// function its command runs, so a tap answers exactly what the typed command answers. A command
// that needs an argument asks for it first (the commandArg flow), and the answer runs
// `/<command> <answer>`.

export interface MoreDeps extends DonateDeps {
  readonly backupKeep: number;
  readonly adminTelegramId: number;
}

type Run = (ctx: Context, deps: MoreDeps) => Promise<void>;

interface MoreButton {
  // The `more:<key>` or `adm:<key>` callback data.
  readonly key: string;
  // The command the button stands for.
  readonly command: string;
  readonly label: string;
  readonly run: Run;
}

// What `/<command> <arg>` runs, for each command a button asks the argument of.
const WITH_ARG: Record<ArgCommand, (ctx: Context, deps: MoreDeps, arg: string) => Promise<void>> = {
  block: (ctx, deps, arg) => sendBlock(ctx, deps, 'block', arg),
  unblock: (ctx, deps, arg) => sendBlock(ctx, deps, 'unblock', arg),
  refund: sendRefund,
  paysupport: sendPaySupport,
  tag: sendTag,
};

const ADMIN_ARG: ReadonlySet<ArgCommand> = new Set<ArgCommand>(['block', 'unblock', 'refund']);

// The prompt becomes the anchor, so its [Отмена] and /cancel end the flow like any other.
async function askArgument(ctx: Context, deps: MoreDeps, command: ArgCommand): Promise<void> {
  if (ctx.from === undefined) return;
  const now = deps.now();
  const user = ensureUser(deps, ctx.from.id, now);
  const flow: CommandArgFlow = { kind: 'commandArg', command };
  startFlow(deps, user, flow, now);
  await showScreen(
    ctx,
    deps,
    user,
    { name: 'commandArg' },
    { text: messages.commandArgPrompt[command], markup: InlineKeyboard.from([cancelRow()]) },
  );
}

const ask =
  (command: ArgCommand): Run =>
  (ctx, deps) =>
    askArgument(ctx, deps, command);

const { moreButtons: label } = messages;

// In screen order, two per row.
const BUTTONS: readonly MoreButton[] = [
  { key: 'rec', command: 'recurring', label: label.recurring, run: sendRecurring },
  { key: 'debt', command: 'debts', label: label.debts, run: sendDebts },
  { key: 'tags', command: 'tags', label: label.tags, run: sendTags },
  { key: 'tag', command: 'tag', label: label.tag, run: ask('tag') },
  { key: 'prc', command: 'prices', label: label.prices, run: sendPrices },
  { key: 'exp', command: 'export', label: label.export, run: sendExportPicker },
  { key: 'chg', command: 'changelog', label: label.changelog, run: (ctx) => sendChangelog(ctx) },
  { key: 'don', command: 'donate', label: label.donate, run: sendDonate },
  { key: 'pay', command: 'paysupport', label: label.paysupport, run: ask('paysupport') },
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

// The admin's rows, two per row, under `adm:<key>`.
const ADMIN_BUTTONS: readonly MoreButton[] = [
  {
    key: 'inv',
    command: 'invite',
    label: label.invite,
    run: (ctx, deps) => sendInvite(ctx, deps, ''),
  },
  { key: 'invs', command: 'invites', label: label.invites, run: sendInvites },
  { key: 'stats', command: 'stats', label: label.stats, run: sendStats },
  { key: 'blk', command: 'block', label: label.block, run: ask('block') },
  { key: 'unb', command: 'unblock', label: label.unblock, run: ask('unblock') },
  { key: 'ref', command: 'refund', label: label.refund, run: ask('refund') },
];

const USER_BUTTONS = [...BUTTONS, UNLOCK, LOCK];

// Every more-screen button: its callback data and the command it runs.
export const MORE_BUTTONS: readonly { readonly data: string; readonly command: string }[] = [
  ...USER_BUTTONS.map(({ key, command }) => ({ data: moreData(key), command })),
  ...ADMIN_BUTTONS.map(({ key, command }) => ({ data: adminData(key), command })),
];

function pairs(
  buttons: readonly MoreButton[],
  data: (key: string) => string,
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  buttons.forEach((button, i) => {
    const cell = InlineKeyboard.text(button.label, data(button.key));
    if (i % 2 === 0) rows.push([cell]);
    else rows.at(-1)?.push(cell);
  });
  return rows;
}

function moreKeyboard(deps: AdminDeps, user: User, telegramId: number): InlineKeyboard {
  const rows = pairs(BUTTONS, moreData);
  const encryption = encryptionState(deps, user).kind;
  if (encryption !== 'off') {
    const toggle = encryption === 'locked' ? UNLOCK : LOCK;
    rows.push([InlineKeyboard.text(toggle.label, moreData(toggle.key))]);
  }
  if (telegramId === deps.adminTelegramId) rows.push(...pairs(ADMIN_BUTTONS, adminData));
  return InlineKeyboard.from(rows);
}

// The [☰ Ещё] tap: the screen as a new message. It holds no state, so any old copy still works.
export async function sendMore(ctx: Context, deps: AdminDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  await replyHtml(ctx, messages.moreScreen, {
    reply_markup: moreKeyboard(deps, user, ctx.from.id),
  });
}

// The answer to a button's argument prompt. The flow is completed first, so a redelivered answer
// finds it answered and runs nothing. The prompt loses its [Отмена], then the command runs with
// the answer as its argument, refusing a bad one as the typed command does.
export async function answerCommandArg(
  ctx: Context,
  deps: MoreDeps,
  anchor: ScreenAnchor | undefined,
  input: {
    readonly user: User;
    readonly flow: CommandArgFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const { command } = input.flow;
  completeFlow(deps, input.user, input.inputKey);
  if (anchor?.screen.name === 'commandArg') {
    await renderAnchor(ctx, anchor, {
      text: messages.commandArgPrompt[command],
      markup: InlineKeyboard.from([]),
    });
  }
  if (ADMIN_ARG.has(command) && ctx.from?.id !== deps.adminTelegramId) return;
  await WITH_ARG[command](ctx, deps, input.text);
}

async function runTap(ctx: Context, deps: MoreDeps, button: MoreButton): Promise<void> {
  if (ctx.from === undefined) return;
  await ctx.answerCallbackQuery();
  // As a typed command does: the pending flow is cleared before the command runs.
  cancelFlow(deps, ensureUser(deps, ctx.from.id, deps.now()));
  await button.run(ctx, deps);
}

export function registerMore(bot: Composer<Context>, deps: MoreDeps): void {
  const userButtons = new Map(USER_BUTTONS.map((b) => [b.key, b]));
  const adminButtons = new Map(ADMIN_BUTTONS.map((b) => [b.key, b]));

  bot.callbackQuery(MORE_ACTION, async (ctx) => {
    const button = userButtons.get(ctx.match[1] ?? '');
    if (button !== undefined) await runTap(ctx, deps, button);
  });

  // From anyone but the admin, an `adm:*` tap falls through to the silent unknown-button answer.
  bot.callbackQuery(ADMIN_ACTION, async (ctx, next) => {
    const button = adminButtons.get(ctx.match[1] ?? '');
    if (ctx.from.id !== deps.adminTelegramId || button === undefined) {
      await next();
      return;
    }
    await runTap(ctx, deps, button);
  });
}
