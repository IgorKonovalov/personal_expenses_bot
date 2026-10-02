import { InlineKeyboard, type CommandContext, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import { cancelFlow, type ScreenAnchor, type SecretFlow } from '../../services/flowSessions.js';
import {
  changePassphrase,
  enableEncryption,
  lockLedger,
  recoverWithCode,
  startRecoverFlow,
  startUnlockFlow,
  unlockLedger,
} from '../../services/ledgerKeys.js';
import type { HandlerDeps } from '../bot.js';
import { RECOVERY_SAVED } from '../callbackData.js';
import { messages } from '../messages.js';
import { joinHtml, replyHtml } from '../render/html.js';
import { renderAnchor, type ScreenView } from '../screens.js';
import { encryptionPromptView, encryptionView, passphrasePromptView } from './settings.js';
import { ensureUser } from './start.js';

// Sealed ledgers (ADR-0020): /unlock, /lock, /recover, and the answers to the secret prompts. A message that
// carries a secret is deleted in the update that brings it, before anything else; the secret is
// never logged, stored in a flow or repeated back.

// A delete that fails (the message is already gone, or too old) costs only the delete.
async function deleteSecretMessage(ctx: Context, deps: HandlerDeps): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch (error) {
    deps.logger.warn(
      { updateId: ctx.update.update_id, err: error instanceof Error ? error.name : typeof error },
      'secret message delete failed',
    );
  }
}

// The first text after a secret prompt expired (ADR-0020): deleted unread, since it may be the
// secret, and the prompt is dropped, so the next text is free again.
export async function answerExpiredSecret(
  ctx: Context,
  deps: HandlerDeps,
  user: User,
): Promise<void> {
  await deleteSecretMessage(ctx, deps);
  cancelFlow(deps, user);
  await replyHtml(ctx, messages.secretPromptExpired);
}

async function show(ctx: Context, anchor: ScreenAnchor | undefined, view: ScreenView) {
  if (anchor === undefined) {
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
    return;
  }
  await renderAnchor(ctx, anchor, view);
}

// The typed answer to a secret prompt. The enable and passphrase-change prompts live in the
// settings anchor; the /unlock and /recover prompts are plain replies, so their answers are too.
export async function answerSecretFlow(
  ctx: Context,
  deps: HandlerDeps,
  anchor: ScreenAnchor | undefined,
  input: {
    readonly user: User;
    readonly flow: SecretFlow;
    readonly text: string;
    readonly inputKey: string;
  },
): Promise<void> {
  const { user, flow } = input;
  await deleteSecretMessage(ctx, deps);
  const secret = {
    user,
    ledgerId: flow.ledgerId,
    passphrase: input.text,
    inputKey: input.inputKey,
  };

  if (flow.kind === 'recoverCode') {
    const result = recoverWithCode(deps, {
      user,
      ledgerId: flow.ledgerId,
      code: input.text,
      inputKey: input.inputKey,
      now: deps.now(),
    });
    switch (result.kind) {
      case 'recovered':
        await replyHtml(ctx, messages.recoveredPrompt);
        return;
      case 'wrongCode':
        await replyHtml(ctx, messages.wrongRecoveryCode);
        return;
      case 'notSealed':
        await replyHtml(ctx, messages.unlockNotSealed);
        return;
    }
  }

  if (flow.kind === 'recoverPassphrase' || flow.kind === 'passphraseChange') {
    // The settings prompt answers in its anchor; the /recover one in plain replies.
    const inAnchor = flow.kind === 'passphraseChange' ? anchor : undefined;
    const result = await changePassphrase(deps, secret);
    switch (result.kind) {
      case 'tooShort':
        if (inAnchor === undefined) {
          await replyHtml(
            ctx,
            joinHtml([messages.passphraseTooShort, messages.recoveredPrompt], '\n\n'),
          );
        } else {
          await renderAnchor(ctx, inAnchor, passphrasePromptView(messages.passphraseTooShort));
        }
        return;
      case 'locked':
        await replyHtml(ctx, messages.ledgerLocked);
        return;
      case 'changed': {
        await replyHtml(ctx, messages.passphraseChanged);
        const view = encryptionView(deps, user);
        if (inAnchor !== undefined && view !== undefined) await renderAnchor(ctx, inAnchor, view);
        return;
      }
    }
  }

  if (flow.kind === 'unlock') {
    const result = await unlockLedger(deps, secret);
    switch (result.kind) {
      case 'unlocked':
        await replyHtml(ctx, messages.unlocked);
        return;
      case 'wrongPassphrase':
        await replyHtml(ctx, messages.wrongPassphrase);
        return;
      case 'notSealed':
        await replyHtml(ctx, messages.unlockNotSealed);
        return;
    }
  }

  const result = await enableEncryption(deps, { ...secret, now: deps.now() });
  switch (result.kind) {
    case 'tooShort':
      await show(ctx, anchor, encryptionPromptView(messages.passphraseTooShort));
      return;
    case 'pendingReceipts':
      await replyHtml(ctx, messages.encryptionPendingReceipts);
      return;
    case 'alreadyEnabled':
    case 'enabled': {
      if (result.kind === 'enabled') {
        await replyHtml(ctx, messages.recoveryCode(result.recoveryCode), {
          reply_markup: new InlineKeyboard().text(messages.recoverySavedButton, RECOVERY_SAVED),
        });
      }
      const view = encryptionView(deps, user);
      if (view !== undefined) await show(ctx, anchor, view);
      return;
    }
  }
}

// A secret typed after the command (`/unlock <passphrase>`, `/recover <code>`) is deleted unread;
// the argument is ignored and the prompt asks for it on its own.
async function deleteCommandArgument(ctx: CommandContext<Context>, deps: HandlerDeps) {
  if (ctx.match.trim() !== '') await deleteSecretMessage(ctx, deps);
}

export function registerUnlock(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('unlock', async (ctx) => {
    if (ctx.from === undefined) return;
    await deleteCommandArgument(ctx, deps);
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    switch (startUnlockFlow(deps, user, now)) {
      case 'asked':
        await replyHtml(ctx, messages.unlockPrompt);
        return;
      case 'off':
        await replyHtml(ctx, messages.unlockNotSealed);
        return;
      case 'unlocked':
        await replyHtml(ctx, messages.alreadyUnlocked);
        return;
    }
  });

  bot.command('lock', async (ctx) => {
    if (ctx.from === undefined) return;
    const user = ensureUser(deps, ctx.from.id, deps.now());
    const result = lockLedger(deps, user);
    await replyHtml(
      ctx,
      result === 'locked'
        ? messages.ledgerLockedNow
        : result === 'alreadyLocked'
          ? messages.alreadyLocked
          : messages.unlockNotSealed,
    );
  });

  bot.command('recover', async (ctx) => {
    if (ctx.from === undefined) return;
    await deleteCommandArgument(ctx, deps);
    const now = deps.now();
    const user = ensureUser(deps, ctx.from.id, now);
    await replyHtml(
      ctx,
      startRecoverFlow(deps, user, now) === 'asked'
        ? messages.recoverPrompt
        : messages.unlockNotSealed,
    );
  });

  // [Сохранил] deletes the recovery code message it sits under.
  bot.callbackQuery(RECOVERY_SAVED, async (ctx) => {
    await ctx.answerCallbackQuery();
    await deleteSecretMessage(ctx, deps);
  });
}
