import type { MiddlewareFn } from 'grammy';
import type { Logger } from '../../logger.js';

// Per-sender update rate limit (ADR-0024): at most `limit` updates per Telegram id in any
// rolling `windowMs`. A dropped update gets no reply and doesn't count toward the window. The
// state lives in this process, which is right for one long-polling instance (ADR-0001).

export const RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

export class RateLimiter {
  // Accepted update times per id, oldest first.
  private readonly accepted = new Map<number, number[]>();
  // When each id's last drop was logged.
  private readonly logged = new Map<number, number>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // True when the update is let through, and then it counts toward the window.
  allow(id: number, nowMs: number): boolean {
    this.sweep(nowMs);
    const recent = (this.accepted.get(id) ?? []).filter((t) => t > nowMs - this.windowMs);
    if (recent.length >= this.limit) {
      this.accepted.set(id, recent);
      return false;
    }
    recent.push(nowMs);
    this.accepted.set(id, recent);
    return true;
  }

  // True at most once per id per window: whether this drop is worth a log line.
  shouldLog(id: number, nowMs: number): boolean {
    const last = this.logged.get(id);
    if (last !== undefined && nowMs - last < this.windowMs) return false;
    this.logged.set(id, nowMs);
    return true;
  }

  // Forgets ids with nothing inside the window, at most once per window, so ids seen once
  // don't accumulate.
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < this.windowMs) return;
    this.lastSweep = nowMs;
    for (const [id, times] of this.accepted) {
      if (times.every((t) => t <= nowMs - this.windowMs)) this.accepted.delete(id);
    }
    for (const [id, at] of this.logged) {
      if (nowMs - at >= this.windowMs) this.logged.delete(id);
    }
  }
}

// Registered before the access check, for private and group updates alike. The admin is exempt;
// an update with no sender passes. A successful_payment passes and doesn't count: the Stars are
// already taken, and Telegram doesn't redeliver an update the bot handled (ADR-0027).
export function rateLimit(deps: {
  readonly adminTelegramId: number;
  readonly logger: Logger;
  readonly now: () => Date;
}): MiddlewareFn {
  const limiter = new RateLimiter(RATE_LIMIT.limit, RATE_LIMIT.windowMs);
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (
      fromId === undefined ||
      fromId === deps.adminTelegramId ||
      ctx.message?.successful_payment !== undefined
    ) {
      await next();
      return;
    }
    const nowMs = deps.now().getTime();
    if (limiter.allow(fromId, nowMs)) {
      await next();
      return;
    }
    if (limiter.shouldLog(fromId, nowMs)) {
      deps.logger.info({ updateId: ctx.update.update_id }, 'update over the rate limit dropped');
    }
  };
}
