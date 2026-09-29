# ADR-0009: Multi-step flows keep their state in SQLite, one pending flow per user

> **Status:** proposed
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0003](../plans/0003-categories.md), [Plan 0004](../plans/0004-dates-edit-summaries.md)

## Context

Adding or renaming a category, and editing an expense's amount, description or date, all need the
bot to ask a question and treat the **next text message** as the answer rather than as a new
expense. Everywhere else, free text is an expense attempt (Plan 0001).

Deploys restart the process (Plan 0002). The sibling bot lost half-done flows to restarts until
it moved sessions into SQLite. Telegram also redelivers an update if the process dies before
acknowledging it. A redelivered answer must not be applied twice, and it must not fall through
and be recorded as an expense.

## Decision

A `flow_sessions` table holds **at most one pending flow per user** (`user_id` is the primary
key). It stores `kind`, a JSON `payload` (for example the expense id and field), the anchor
message's chat and message id, `expires_at` (10 minutes after start) and `last_input_key`.

The text handler routes in this order:

1. If the message's source key (`tg:<chat_id>:<message_id>`) equals `last_input_key`, this is a
   redelivered answer. Ignore it: the flow was already applied. Record nothing, reply nothing.
2. If a flow is pending and not expired, the text is that flow's input. A valid input completes
   the flow, sets `last_input_key` and clears the pending state. An invalid input re-asks and
   keeps the flow pending.
3. Otherwise, parse the text as an expense (Plan 0001).

Starting a flow replaces any pending one. `/cancel`, the prompt's [Отмена] button, and **any
other command** clear the pending flow. Prompts use Telegram's `force_reply` so the client opens
a reply box, but a reply isn't required. Routing is by pending state, not by `reply_to_message`.

## Consequences

### Positive
- Survives restarts and deploys. A prompt sent before a deploy still works after it.
- A redelivered answer is idempotent by the same source-key rule as expenses.
- One routing rule for every future flow (categories, edit, settings).

### Negative
- While a flow is pending, a real expense typed by mistake is consumed as the flow's answer (for
  example "450 кофе" becomes a category name). Mitigations: the prompt says what it expects and
  offers [Отмена], flows expire after 10 minutes, and each flow validates its input and re-asks
  on nonsense (a category name that parses as an expense is rejected with a hint).
- One pending flow per user. Starting a second flow silently drops the first.

## Alternatives considered

### Alternative A: In-memory session (grammY `session()` with the memory adapter)
It needs no table. It lost because every deploy and restart drops pending flows, and nothing
survives to recognise a redelivered answer.

### Alternative B: Match answers only by `reply_to_message` to the prompt
It needs no pending state, and a stray expense is never swallowed. It lost because users
dismiss the reply box or answer without replying, and then the answer is recorded as an expense
or rejected as not-an-expense. It fails in the common case to prevent the rare one.
