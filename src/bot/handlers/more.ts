import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { User } from '../../db/users.js';
import {
  cancelFlow,
  completeFlow,
  setAnchor,
  startFlow,
  type ArgCommand,
  type CommandArgFlow,
  type ScreenAnchor,
} from '../../services/flowSessions.js';
import { encryptionState } from '../../services/ledgerKeys.js';
import type { AdminDeps } from '../bot.js';
import {
  ADMIN_ACTION,
  MENU_OPEN,
  MORE_ACTION,
  SETTINGS_DELETE,
  SETTINGS_PRIVACY,
  STICKY_TAG_ASK,
  adminData,
  moreData,
} from '../callbackData.js';
import type { MenuOpened } from '../keyboards.js';
import { messages } from '../messages.js';
import { editHtml, editHtmlAt, replyHtml } from '../render/html.js';
import { cancelRow, renderAnchor, showScreen } from '../screens.js';
import { sendBlock, sendStats } from './admin.js';
import { changelogFromMenu } from './changelog.js';
import { debtsFromMenu } from './debts.js';
import { donateFromMenu, type DonateDeps } from './donate.js';
import { exportFromMenu } from './export.js';
import { helpView } from './help.js';
import { sendInvite, sendInvites } from './invite.js';
import { sendPaySupport } from './paysupport.js';
import { pricesFromMenu } from './prices.js';
import { recurringFromMenu } from './recurring.js';
import { sendRefund } from './refund.js';
import { settingsFromMenu } from './settings.js';
import { ensureUser } from './start.js';
import { sendTag, tagsFromMenu } from './tags.js';
import { sendLock, sendUnlock } from './unlock.js';

// [☰ Меню] (ADR-0050): a stateless hub, and a second level under it. A hub button edits the
// tapped message into the screen its typed command sends, with [« Назад] (`more:open`) back to
// the hub; a stateful screen adopts the message as its anchor. A button that asks a question
// first (the commandArg flow) or answers with a plain reply still sends a new message, as its
// typed command does. Every private command stays reachable by a button at some depth.

export interface MoreDeps extends DonateDeps {
  readonly backupKeep: number;
  readonly adminTelegramId: number;
}

type Run = (ctx: Context, deps: MoreDeps) => Promise<void>;
type Open = (deps: MoreDeps, user: User) => MenuOpened;

// A button on the hub or one of its screens: it opens a screen in place, or runs as its typed
// command does.
type MoreButton = {
  // The `more:<key>` or `adm:<key>` callback data.
  readonly key: string;
  // The command the button stands for.
  readonly command: string;
  readonly label: string;
} & ({ readonly open: Open } | { readonly run: Run });

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

// The hub's [Помощь]: the help screen /help sends, its topics carrying the hub mark.
function helpFromMenu(): MenuOpened {
  return { view: helpView(true) };
}

const DONATE: MoreButton = {
  key: 'don',
  command: 'donate',
  label: label.donate,
  open: (deps) => donateFromMenu(deps),
};
const RECURRING: MoreButton = {
  key: 'rec',
  command: 'recurring',
  label: label.recurring,
  open: recurringFromMenu,
};
const DEBTS: MoreButton = {
  key: 'debt',
  command: 'debts',
  label: label.debts,
  open: debtsFromMenu,
};
const TAGS: MoreButton = { key: 'tags', command: 'tags', label: label.tags, open: tagsFromMenu };
const PRICES: MoreButton = {
  key: 'prc',
  command: 'prices',
  label: label.prices,
  open: pricesFromMenu,
};
const EXPORT: MoreButton = {
  key: 'exp',
  command: 'export',
  label: label.export,
  open: exportFromMenu,
};
const SETTINGS: MoreButton = {
  key: 'set',
  command: 'settings',
  label: label.settings,
  open: settingsFromMenu,
};
const HELP: MoreButton = { key: 'help', command: 'help', label: label.help, open: helpFromMenu };

// The hub's rows, from the top.
const HUB_ROWS: readonly (readonly MoreButton[])[] = [
  [DONATE],
  [RECURRING, DEBTS],
  [TAGS, PRICES],
  [EXPORT, SETTINGS],
  [HELP],
];

// Shown only for a sealed personal ledger: the one that changes its state.
const UNLOCK: MoreButton = { key: 'unl', command: 'unlock', label: label.unlock, run: sendUnlock };
const LOCK: MoreButton = { key: 'lock', command: 'lock', label: label.lock, run: sendLock };

// Buttons on the screens the hub opens: [Что нового] under its help, [Вопрос о пожертвовании] on
// /donate.
const CHANGELOG: MoreButton = {
  key: 'chg',
  command: 'changelog',
  label: label.changelog,
  open: () => changelogFromMenu(),
};
const PAYSUPPORT: MoreButton = {
  key: 'pay',
  command: 'paysupport',
  label: label.paysupport,
  run: ask('paysupport'),
};

// The admin's sub-screen, behind [Админ]: two per row, under `adm:<key>`.
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

const USER_BUTTONS = [...HUB_ROWS.flat(), UNLOCK, LOCK, CHANGELOG, PAYSUPPORT];

// The `more:<key>` buttons that open their screen in the tapped message, and the command each
// stands for.
export const MENU_IN_PLACE: readonly { readonly data: string; readonly command: string }[] =
  USER_BUTTONS.flatMap((b) => ('open' in b ? [{ data: moreData(b.key), command: b.command }] : []));

// Every button of the hub and the screens under it, and the command it reaches.
export const MENU_BUTTONS: readonly { readonly data: string; readonly command: string }[] = [
  ...USER_BUTTONS.map(({ key, command }) => ({ data: moreData(key), command })),
  ...ADMIN_BUTTONS.map(({ key, command }) => ({ data: adminData(key), command })),
  // [Постоянная метка] on /tags.
  { data: STICKY_TAG_ASK, command: 'tag' },
  // [Приватность] and [Удалить аккаунт] on settings' Аккаунт и данные.
  { data: SETTINGS_PRIVACY, command: 'privacy' },
  { data: SETTINGS_DELETE, command: 'delete_account' },
];

function cell(button: MoreButton, data: (key: string) => string): InlineKeyboardButton {
  return InlineKeyboard.text(button.label, data(button.key));
}

function hubKeyboard(deps: AdminDeps, user: User, telegramId: number): InlineKeyboard {
  const rows = HUB_ROWS.map((row) => row.map((button) => cell(button, moreData)));
  const encryption = encryptionState(deps, user).kind;
  if (encryption !== 'off') rows.push([cell(encryption === 'locked' ? UNLOCK : LOCK, moreData)]);
  if (telegramId === deps.adminTelegramId) {
    rows.push([InlineKeyboard.text(label.admin, moreData('adm'))]);
  }
  return InlineKeyboard.from(rows);
}

function adminKeyboard(): InlineKeyboard {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < ADMIN_BUTTONS.length; i += 2) {
    rows.push(ADMIN_BUTTONS.slice(i, i + 2).map((button) => cell(button, adminData)));
  }
  rows.push([InlineKeyboard.text(messages.backButton, MENU_OPEN)]);
  return InlineKeyboard.from(rows);
}

// The [☰ Меню] tap: the hub as a new message. It holds no state, so any old copy still works.
export async function sendMore(ctx: Context, deps: AdminDeps): Promise<void> {
  if (ctx.from === undefined) return;
  const user = ensureUser(deps, ctx.from.id, deps.now());
  await replyHtml(ctx, messages.moreScreen, {
    reply_markup: hubKeyboard(deps, user, ctx.from.id),
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

// The prologue of every menu tap: answered, and the pending flow cleared as a typed command
// clears it.
async function menuTap(ctx: Context, deps: MoreDeps): Promise<User | undefined> {
  if (ctx.from === undefined) return undefined;
  await ctx.answerCallbackQuery();
  const user = ensureUser(deps, ctx.from.id, deps.now());
  cancelFlow(deps, user);
  return user;
}

async function runTap(ctx: Context, deps: MoreDeps, button: MoreButton): Promise<void> {
  const user = await menuTap(ctx, deps);
  if (user === undefined) return;
  if ('run' in button) {
    await button.run(ctx, deps);
    return;
  }
  const tapped = ctx.callbackQuery?.message;
  if (tapped === undefined) return;
  const opened = button.open(deps, user);
  const at = { chatId: tapped.chat.id, messageId: tapped.message_id };
  if (opened.screen !== undefined) setAnchor(deps, user, { ...at, screen: opened.screen });
  await editHtmlAt(ctx, at, opened.view.text, {
    reply_markup: opened.view.markup,
    ...(opened.noPreview === true ? { link_preview_options: { is_disabled: true } } : {}),
  });
}

export function registerMore(bot: Composer<Context>, deps: MoreDeps): void {
  const userButtons = new Map(USER_BUTTONS.map((b) => [b.key, b]));
  const adminButtons = new Map(ADMIN_BUTTONS.map((b) => [b.key, b]));

  // [« Назад] on every screen the hub opened: the hub again, in the same message.
  bot.callbackQuery(MENU_OPEN, async (ctx) => {
    const user = await menuTap(ctx, deps);
    if (user === undefined) return;
    await editHtml(ctx, messages.moreScreen, {
      reply_markup: hubKeyboard(deps, user, ctx.from.id),
    });
  });

  // [Постоянная метка] on /tags: the /tag prompt.
  bot.callbackQuery(STICKY_TAG_ASK, async (ctx) => {
    if ((await menuTap(ctx, deps)) === undefined) return;
    await askArgument(ctx, deps, 'tag');
  });

  // [Админ], for the admin only: the hub becomes the admin's buttons. From anyone else it falls
  // through to the silent unknown-button answer, as a forged `adm:*` tap does.
  bot.callbackQuery(moreData('adm'), async (ctx, next) => {
    if (ctx.from.id !== deps.adminTelegramId) {
      await next();
      return;
    }
    if ((await menuTap(ctx, deps)) === undefined) return;
    await editHtml(ctx, messages.adminScreen, { reply_markup: adminKeyboard() });
  });

  bot.callbackQuery(MORE_ACTION, async (ctx, next) => {
    const button = userButtons.get(ctx.match[1] ?? '');
    if (button === undefined) {
      await next();
      return;
    }
    await runTap(ctx, deps, button);
  });

  bot.callbackQuery(ADMIN_ACTION, async (ctx, next) => {
    const button = adminButtons.get(ctx.match[1] ?? '');
    if (ctx.from.id !== deps.adminTelegramId || button === undefined) {
      await next();
      return;
    }
    await runTap(ctx, deps, button);
  });
}
