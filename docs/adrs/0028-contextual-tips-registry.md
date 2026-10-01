# ADR-0028: Contextual tips are a registry of conditions, shown as one capped message, seen when sent

> **Status:** proposed
> **Date:** 2026-10-01
> **Related plan(s):** Plan 0015 ([0015-onboarding.md](../plans/0015-onboarding.md))

## Context

The bot does more than its first message can teach: categories, past dates, the edit flow,
receipts, budgets, groups, export and encryption. Plan 0015 teaches each feature when it becomes
relevant, with a short tip after the reply that made it relevant. Every later feature plan will
want a tip of its own, so the mechanism is a seam that outlives this plan.

Three things could reasonably go either way. One is where a tip appears (inside the reply, or as
its own message). Another is when it counts as seen (when sent, or when acknowledged). The last
is how a feature declares one (code in each handler, or one table of entries).

## Decision

A tip is an entry in one registry in `src/domain/tips.ts`: a stable key, the trigger it listens
to, and a pure condition over a small context the service assembles. The context holds counts,
the ledger kind, whether a budget exists, the expense's currency and category, and so on. The
messages module holds each tip's copy under the same key. A handler that just replied calls
`offerTip(trigger, context)` once. The service picks the first registry entry for that trigger
whose condition holds and whose key the user hasn't been shown. It shows nothing when the user
switched tips off, a tip was already shown on the user's current local day, a text flow is
pending, or the chat is a group.

The chosen tip is recorded in `user_tips` before it is sent, so a redelivered update can't show
it twice and a failed send loses it. It goes out as its own message with one button,
[Отключить подсказки]. A trigger is a condition, not a first occurrence: a tip held back by the
daily cap shows the next time its condition holds. A new feature adds a tip by adding a registry
entry, a message and one `offerTip` call.

## Consequences

### Positive
- One place lists every tip, its trigger and its condition, so the daily cap and the off switch
  can't be bypassed by a handler.
- Conditions are pure and unit-tested without a bot.
- Replies stay unchanged: a confirmation or report never grows a paragraph that later disappears.

### Negative
- A tip is an extra message, so an action can produce two (reply plus tip). The daily cap
  bounds it.
- "Seen when sent" means a user who scrolls past a tip never sees it again. Replay through
  `/start` (Plan 0015) is the remedy.
- A tip on a feature the user already found by themselves still shows once.

## Alternatives considered

### Alternative A: the tip appended to the reply
No extra message. It lost because the reply is an anchor that gets edited later (undo, category,
edit). The tip would either persist in every re-render or vanish on the first edit, and every
renderer would need to know about tips.

### Alternative B: seen only when acknowledged with a button
This guarantees the user read it. It lost because it needs a button on every tip and per-tip
state that waits for a tap. An unacknowledged tip would keep repeating, which turns teaching into
nagging.

### Alternative C: each handler decides its own tip
No registry: a handler checks its own condition and sends. It lost because the daily cap, the
off switch, the flow check and the group check would be copied into each handler, and the first
copy that forgets one breaks the promise.
