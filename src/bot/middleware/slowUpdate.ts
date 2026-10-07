import type { MiddlewareFn } from 'grammy';
import type { Logger } from '../../logger.js';

// Updates run one at a time, so one slow update delays every user's next one.
export const SLOW_UPDATE_MS = 1_000;

// Times each update through the rest of the chain, a failing one included, and logs one warn
// for an update over SLOW_UPDATE_MS. The line carries the update's type and the duration only:
// no text, ids, amounts or file names.
export function slowUpdate(deps: {
  readonly logger: Logger;
  // Milliseconds on a monotonic clock; tests inject one.
  readonly clockMs?: () => number;
}): MiddlewareFn {
  const clockMs = deps.clockMs ?? (() => performance.now());
  return async (ctx, next) => {
    const started = clockMs();
    try {
      await next();
    } finally {
      const ms = Math.round(clockMs() - started);
      if (ms > SLOW_UPDATE_MS) {
        const updateType = Object.keys(ctx.update).find((key) => key !== 'update_id') ?? 'unknown';
        deps.logger.warn({ updateType, ms }, 'slow update');
      }
    }
  };
}
