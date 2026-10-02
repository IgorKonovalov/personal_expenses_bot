import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { User } from '../../db/users.js';
import type { ScreenAnchor, SecretFlow } from '../../services/flowSessions.js';
import { enableEncryption, startUnlockFlow, unlockLedger } from '../../services/ledgerKeys.js';
import type { HandlerDeps } from '../bot.js';
import { RECOVERY_SAVED } from '../callbackData.js';
import { messages } from '../messages.js';
import { replyHtml } from '../render/html.js';
import { renderAnchor, type ScreenView } from '../screens.js';
import { encryptionPromptView, encryptionView } from './settings.js';
import { ensureUser } from './start.js';

// Sealed ledgers (ADR-0020): /unlock, and the answers to the secret prompts. A message that
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

async function show(ctx: Context, anchor: ScreenAnchor | undefined, view: ScreenView) {
  if (anchor === undefined) {
    await replyHtml(ctx, view.text, { reply_markup: view.markup });
    return;
  }
  await renderAnchor(ctx, anchor, view);
}

// The typed answer to a secret prompt. The enable prompt lives in the settings anchor; the
// /unlock prompt is a plain reply, so its answer is too.
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

export function registerUnlock(bot: Composer<Context>, deps: HandlerDeps): void {
  bot.command('unlock', async (ctx) => {
    if (ctx.from === undefined) return;
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

  // [Сохранил] deletes the recovery code message it sits under.
  bot.callbackQuery(RECOVERY_SAVED, async (ctx) => {
    await ctx.answerCallbackQuery();
    await deleteSecretMessage(ctx, deps);
  });
}
