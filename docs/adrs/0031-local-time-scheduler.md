# ADR-0031: One minute-tick scheduler fires per-ledger jobs at a local time, keyed by occurrence date

> **Status:** proposed
> **Date:** 2026-10-02
> **Related plan(s):** Plan 0025 ([0025-recurring-expenses-and-reminders.md](../plans/0025-recurring-expenses-and-reminders.md)),
> and Plan 0026 (its first reuse)

## Context

Plan 0025 needs the bot's first user-facing scheduled work: record rent on the 1st at 09:00 in
the ledger's timezone, or send a reminder. Plan 0026 (the monthly summary push) and possibly debt
reminders will need the same. The existing workers (receipts, rates, backups) run on a fixed
`setInterval` with no notion of a user's local time.

The process restarts on every deploy, and the VPS can be down for hours. A job that was due while
the bot was down must still happen, and exactly once: a redelivered or retried tick must never
record rent twice. Time zones move under DST, and a user can change their timezone between
two occurrences.

## Decision

A single scheduler worker in `src/scheduler/` ticks every 60 seconds, plus once at boot, with an
in-flight guard like the rate worker's. Each job kind registers a provider with two functions.
`due(now)` returns the occurrences whose local due instant has passed. `fire(occurrence)` runs one.

An occurrence is identified by `(job id, local due date)`. It is claimed by inserting that key
into the kind's occurrence table in the same SQLite transaction that does the job's work and
advances the job's next due date. A duplicate key means it already happened, so it is skipped.
Telegram messages are sent after the commit. A failed send is logged and not retried, so the
recorded fact stands and only the notice is lost.

A job's next due occurrence is a **local date**, never an instant. A provider either stores it
(`next_due_on`, as Plan 0025's rules do) or derives it each tick from state it already owns (Plan
0026 derives it from the ledger's period rules, so a changed budget start day needs no rewrite).
The due instant is computed on each tick as 09:00 on that date in the job's current timezone (the
ledger's effective timezone, ADR-0015). So a DST change or a timezone change applies to the next
occurrence without a migration. After downtime, a provider decides its own catch-up: Plan 0025
records each missed expense occurrence on its own date (at most 31 per job per tick), and sends
only the latest missed reminder.

## Consequences

### Positive
- No dependency and no in-memory timers to rebuild at boot: the database is the schedule.
- Exactly-once work per occurrence, through the same transaction-plus-unique-key rule that
  expenses already use for redelivered updates.
- Plan 0026 adds a provider, not a scheduler.

### Negative
- Up to a minute of latency, and a full scan of due jobs every minute. That's an indexed query on
  `next_due_on` over a few hundred rows, negligible here, and it would need batching at a scale
  this bot won't reach.
- A lost Telegram notice isn't retried. For an auto-recorded expense the record still exists and
  shows in `/today`. For a reminder, the reminder is simply lost.
- One fixed hour (09:00) for every job. A per-job time would be a column, if asked for.

## Alternatives considered

### Alternative A: a cron library (`node-cron` or `croner`) with per-user expressions
Timezone-aware expressions out of the box. It lost because the schedule would live in memory and
have to be rebuilt from the database at every boot anyway. It has no catch-up for occurrences
missed while down, and it's a dependency for what is one indexed query a minute.

### Alternative B: a `setTimeout` per job until its next occurrence
Precise to the second. It lost on restarts (every timer is lost), on Node's 24.8-day timer limit
(a yearly job needs re-arming), and on DST, because a timer armed in July fires an hour off in
November unless it's recomputed.
