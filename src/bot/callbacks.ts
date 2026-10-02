import type { Context, MiddlewareFn } from 'grammy';

// The callback dispatcher's prologue and fallback (ADR-0011). Every callback query is answered
// exactly once: a second answerCallbackQuery on the same update is a no-op, so the error boundary
// can answer after a handler that already did. A query no handler answered (unknown or stale
// data) is answered silently once the whole chain has run, so handlers registered later still
// see every scope.

const answered = new WeakSet<Context>();

export function callbackAnswered(ctx: Context): boolean {
  return answered.has(ctx);
}

// Runs `work` for a tap unless an earlier tap on the same message is still running it: the
// double-tap guard for a tap that sends something. Held in memory only, so a redelivery after a
// restart runs again. Returns false for a dropped tap, and for a tap with no message to key by.
export function createTapGuard(): (ctx: Context, work: () => Promise<void>) => Promise<boolean> {
  const busy = new Set<string>();
  return async (ctx, work) => {
    const message = ctx.callbackQuery?.message;
    if (message === undefined) return false;
    const key = `${message.chat.id}:${message.message_id}`;
    if (busy.has(key)) return false;
    busy.add(key);
    try {
      await work();
    } finally {
      busy.delete(key);
    }
    return true;
  };
}

export function callbackDispatcher(): MiddlewareFn {
  return async (ctx, next) => {
    if (ctx.callbackQuery === undefined) {
      await next();
      return;
    }
    const answer = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = (...args) => {
      if (answered.has(ctx)) return Promise.resolve(true);
      answered.add(ctx);
      return answer(...args);
    };
    await next();
    if (!answered.has(ctx)) await ctx.answerCallbackQuery();
  };
}
