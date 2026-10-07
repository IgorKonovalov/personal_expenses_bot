# ADR-0043: Scheduled sends are paced and capped per tick, skip unreachable users, and find due pushes in bulk

> **Status:** accepted (2026-10-07)
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0039](../plans/done/0039-scale-hardening.md)

## Context

The scheduler (ADR-0031) ticks every minute. On each tick, `dueSummaries` walks every user who has
a push on, and `monthly_push` defaults to 1, so that is nearly everyone. Each user costs a
personal-ledger read, a budget read, a new `Intl.DateTimeFormat` in `canonicalTimezone`, and a
claim lookup. We estimate 250 to 350 µs per user, or 2.5 to 3.5 s of blocked event loop per
minute at 10,000 users. That is an estimate from the 2026-10-07 audit, not a measurement.

On the 1st, most users share one or two timezones, so about 10,000 pushes fall due at 09:00
together. `register` fires them back to back with no pacing. Nothing handles Telegram's 429 or
`retry_after`. The other providers (recurring expenses, reminders) wait until the whole fan-out
ends.

A push is claimed before it is sent (at-most-once). That stays: a crash between send and claim
would otherwise push twice. As a result, a 429 today loses that push for good.

A user who blocks the bot makes every later send fail with 403, every month, forever.
`users.blocked_at` is the admin's abuse block (ADR-0024). It must not be overloaded.

## Decision

- **Unreachable users.** A new `users.unreachable_at` is set in three cases:
  - a private-chat `my_chat_member` update says the bot was blocked (`kicked`);
  - a scheduled send gets a 403 ("bot was blocked", "user is deactivated");
  - nothing else sets it.

  It is cleared by the matching `member` update or by any private update from that user. Push
  recipients and reminder sends skip unreachable users. The settings are untouched, so a
  returning user gets their pushes back without doing anything.
- **Paced, bounded sends.** Scheduled messages go through one sender in the bot adapter:
  - It leaves at least 40 ms between sends, so at most 25 a second.
  - On a 429 it waits `retry_after` and retries, at most twice.
  - On a 403 it marks the user unreachable and does not retry.

  Claim-before-send stays.
- **A cap per tick.** `register` fires at most `MAX_FIRES_PER_TICK = 200` occurrences per
  provider per tick. Whatever is left is due again on the next tick. 10,000 pushes take 50
  ticks of at least 8 s of sends each, so about 50 minutes. That is well inside the 7-day
  `CATCH_UP_MS`. Every other provider runs in each of those ticks.
- **Due pushes in bulk.** `dueSummaries` reads every recipient's inputs in one joined query:
  user, identity, personal ledger, budget start day, both timezones. It memoizes per tick the
  canonical timezone and the zone's local date. It loads the claimed keys of the candidate
  periods in one query. The number of statements per tick no longer depends on the number of
  users.

## Consequences

### Positive
- Each minute's tick costs tens of ms at 10,000 users instead of seconds.
- A month's fan-out survives 429s and leaves the recurring providers running.
- Blocked users stop costing a doomed API call each month, and they return transparently.

### Negative
- A push lost after two retries, or to a crash mid-send, stays lost (at-most-once).
- A fan-out now takes about 50 minutes. The last users get their summary up to about an hour
  after 09:00.
- The joined recipient query still scans every user each tick, in SQLite, not JS. That is
  linear, with a small constant.
- A 403 from an ordinary handler reply does not mark a user unreachable; only scheduled sends
  do. The `my_chat_member` update covers the rest.

## Alternatives considered

### Alternative A: a stored `next_push_at` per ledger, indexed
Querying `WHERE next_push_at <= now` costs only the due rows. It lost because it needs
invalidating on every input change: a user or ledger timezone, the budget's start day, a push
toggled, and every claim. A missed invalidation silently skips someone's summary. The bulk read
gives most of the gain with no stored state.

### Alternative B: the `@grammyjs/auto-retry` plugin on the whole API
It handles 429s in one line. It lost for two reasons. It is one more dependency. And installed
globally, it would make an ordinary handler sleep through `retry_after` while holding the
sequential update loop (ADR-0042). Only the scheduler's sends need retries.

### Alternative C: turn pushes off on 403
Simpler, with no new column. It lost because a user who unblocks the bot would silently stop
getting the summaries they had chosen.
