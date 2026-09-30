# ADR-0015: A shared ledger carries its own timezone, used for its dates and periods

> **Status:** proposed
> **Date:** 2026-09-30
> **Related plan(s):** [Plan 0009](../plans/0009-group-ledgers.md)

## Context

"Today" and "this month" are computed in the user's timezone (a non-negotiable). ADR-0002
accepted that in a shared ledger `occurred_on` is the *author's* local date, so two members in
different timezones may disagree about a day.

A group digest (Plan 0009) and, later, a group budget and a scheduled group post need one answer
for everyone. A monthly budget of 40 000 RSD can't have two different month ends, and a
"weekly post on Monday 09:00" needs one clock. If `occurred_on` stays in the author's timezone
while the period boundary is in another, an expense near midnight is counted in a month that
neither the author nor the reader expects.

## Decision

> `ledgers.timezone` is an IANA zone that is `NOT NULL` for `shared` ledgers and `NULL` for
> `personal` ones. The effective timezone of an expense or a report is
> `ledger.timezone ?? user.timezone`. It is used both for `occurred_on` at record time and for
> period boundaries at report time, so the two can't disagree. A new shared ledger takes its
> creator's timezone, and only the ledger owner changes it. A change applies to expenses
> recorded afterwards: stored `occurred_on` values are never rewritten.

This supersedes ADR-0002's consequence that `occurred_on` in a shared ledger is the author's
local date.

## Consequences

### Positive
- One month edge per shared ledger for digests, budgets and scheduled posts.
- Personal ledgers behave exactly as before (`NULL` falls through to the user's timezone).
- Moving `/settings`' timezone onto a ledger later (e.g. for a trip ledger) needs no new concept.

### Negative
- A member abroad sees group expenses dated in the group's timezone, not their own. `500 такси`
  sent at 19:30 in New York lands on the next day in a Belgrade ledger.
- Changing a ledger's timezone leaves old rows dated in the old zone. A boundary expense can
  shift month relative to a hypothetical re-computation. We accept this rather than rewrite
  history.
- One more place to resolve an invalid stored zone: the existing fallback to the default zone
  (with a warn log) applies to ledger zones too.

## Alternatives considered

### Alternative A: Viewer's timezone at report time
Each reader computes periods in their own zone. It lost because a budget or a scheduled post
has no single viewer, and because `occurred_on` (stored in the author's zone) and the boundary
(in the viewer's zone) would disagree for expenses near midnight.

### Alternative B: Store only instants and compute every date at read time
It removes `occurred_on` entirely. It lost because past-dated expenses (Plan 0004) are dates,
not instants, and because it rewrites the ledger model that ADR-0002 settled.
