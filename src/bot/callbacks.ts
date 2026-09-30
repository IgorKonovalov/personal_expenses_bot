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
