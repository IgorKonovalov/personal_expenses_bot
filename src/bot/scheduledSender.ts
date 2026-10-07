import { GrammyError, type Api } from 'grammy';
import type { Message } from 'grammy/types';
import type { Db } from '../db/connection.js';
import { markUnreachable } from '../db/users.js';
import type { Logger } from '../logger.js';
import { sendHtml, type Html } from './render/html.js';

// The one way the scheduler's providers write to Telegram (ADR-0043). Sends are serialised and
// paced at least SEND_GAP_MS apart, which keeps a fan-out under Telegram's broadcast limit. A
// 429 sleeps the `retry_after` it names and retries, at most MAX_SEND_RETRIES times, then the
// last error is thrown for the provider to log. A 403 means the user blocked the bot: the
// recipient is marked unreachable, which takes them out of later pushes, and nothing is retried.

export const SEND_GAP_MS = 40;
export const MAX_SEND_RETRIES = 2;

type SendOther = Parameters<typeof sendHtml>[3];

// `sent`, or `unreachable` for a 403.
export type ScheduledSendOutcome = 'sent' | 'unreachable';

export interface ScheduledSender {
  readonly send: (chatId: number, body: Html, extra?: SendOther) => Promise<ScheduledSendOutcome>;
}

export interface ScheduledSenderDeps {
  readonly api: Api;
  readonly db: Db;
  readonly logger: Logger;
  readonly now: () => Date;
  // Milliseconds on a monotonic clock, and a sleep on it; tests inject both.
  readonly clockMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function scheduledSender(deps: ScheduledSenderDeps): ScheduledSender {
  const clockMs = deps.clockMs ?? (() => performance.now());
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  let lastSentAt: number | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  // One API call, at least SEND_GAP_MS after the previous one started.
  const paced = async (call: () => Promise<Message>): Promise<Message> => {
    if (lastSentAt !== undefined) {
      const wait = lastSentAt + SEND_GAP_MS - clockMs();
      if (wait > 0) await sleep(wait);
    }
    lastSentAt = clockMs();
    return call();
  };

  const attempt = async (
    chatId: number,
    body: Html,
    extra: SendOther,
  ): Promise<ScheduledSendOutcome> => {
    for (let retries = 0; ; retries += 1) {
      try {
        await paced(() => sendHtml(deps.api, chatId, body, extra));
        return 'sent';
      } catch (error) {
        if (!(error instanceof GrammyError)) throw error;
        if (error.error_code === 403) {
          markUnreachable(deps.db, chatId, deps.now());
          deps.logger.info({ outcome: 'unreachable' }, 'scheduled send refused');
          return 'unreachable';
        }
        const retryAfter = error.parameters.retry_after;
        if (error.error_code !== 429 || retryAfter === undefined || retries >= MAX_SEND_RETRIES) {
          throw error;
        }
        await sleep(retryAfter * 1000);
      }
    }
  };

  return {
    send: (chatId, body, extra = {}) => {
      const result = queue.then(() => attempt(chatId, body, extra));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
