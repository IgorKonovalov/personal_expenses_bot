# ADR-0037: One-time notices are rows in `user_notices`, and transient replies are deleted by an in-process timer

> **Status:** accepted (2026-10-06, at the close of Plan 0034)
> **Date:** 2026-10-06
> **Related plan(s):** [Plan 0034](../plans/done/0034-pre-invite-polish.md) Phase 4

## Context

Several bot replies explain something the user needs to read once: the full help on stray
input, the hint that editing a message doesn't edit its expense, and the sealed-ledger warnings.
Repeated on every occurrence, they bury the chat. The bot has to remember, per user, which
explanations it has given, and it must survive restarts and redeliveries.

Plan 0015 (ADR-0028) brings `user_tips` for teaching tips. A tip is capped at one a day, can be
turned off, and is replayed by `/start`. An explanation is shown once and never replayed, and
turning tips off must not hide it.

Some replies only matter for a moment: the one-line "didn't understand" after the full help has
been seen. Deleting them later needs either a timer or a stored deletion job.

## Decision

> A `user_notices (user_id, notice, seen_at)` table, keyed by user and notice, records each
> one-time explanation the bot has shown. A notice is marked seen with one `INSERT OR IGNORE`,
> and the insert's change count says whether this occurrence is the first. That makes two
> concurrent first occurrences produce one notice. Notice keys live in one constant beside the
> repository. Transient replies are deleted 60 seconds after sending by an in-process `setTimeout`.
> A restart before it fires leaves the reply in the chat.

## Consequences

### Positive
- One statement decides "first time", so redelivery and double taps can't show a notice twice.
- Notices stay independent of tips: `tips_off` and the `/start` replay don't touch them.
- No job table, worker or migration for deleting a one-line reply.

### Negative
- Two "seen once" tables exist once Plan 0015 lands. A reader has to know which one a message
  belongs to, and the rule is that a replayable teaching message is a tip and an explanation is a
  notice.
- A restart inside the 60 seconds strands that transient reply.
- `/delete_account` has one more table to clear.

## Alternatives considered

### Alternative A: reuse Plan 0015's `user_tips`
One table for every "seen once" message. It lost because the tip semantics (the daily cap,
`tips_off`, the replay on `/start`) would hide or replay explanations that must be shown exactly
once, and 0015 hasn't merged, so this plan would have to build its table first.

### Alternative B: a persisted deletion queue
Store `(chat_id, message_id, delete_at)` and let a worker delete due rows, surviving restarts. It
lost on cost: a migration, a worker and its tests, to rescue a one-line reply from a rare restart.
