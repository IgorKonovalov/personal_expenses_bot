# ADR-0009: Multi-step flows keep their state in SQLite, one pending flow per user

> **Status:** accepted (2026-09-30)
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0003](../plans/done/0003-categories.md), [Plan 0004](../plans/done/0004-dates-edit-summaries.md), [Plan 0005](../plans/done/0005-settings.md)
> **Revised:** 2026-09-29, before acceptance: prompts edit the anchor instead of using
> `force_reply`, expiry is answered, expense-shaped answers are rejected, and the row also holds
> ADR-0011's screen anchor.

## Context

Adding or renaming a category, and editing an expense's amount, description or date, all need the
bot to ask a question and treat the **next text message** as the answer rather than as a new
expense. Everywhere else, free text is an expense attempt (Plan 0001).

Deploys restart the process (Plan 0002). The sibling bot lost half-done flows to restarts until
it moved sessions into SQLite. Telegram also redelivers an update if the process dies before
acknowledging it. A redelivered answer must not be applied twice, and it must not fall through
and be recorded as an expense.

## Decision

A `flow_sessions` table holds **one row per user** (`user_id` is the primary key). It carries
two things. The first is the user's **screen anchor** (ADR-0011): the anchor message's chat and
message id, the `screen` it shows, and a JSON `screen_ctx` (for example the ledger id a summary
shows). The second is **at most one pending text flow**: `kind`, a JSON `payload` (for example
the expense id and field), `expires_at` (10 minutes after the prompt), and `last_input_key`.

The text handler routes in this order, after commands and menu taps (ADR-0011):

1. If the message's source key (`tg:<chat_id>:<message_id>`) equals `last_input_key`, this is a
   redelivered answer. Ignore it: the flow was already applied. Record nothing, reply nothing.
2. If a flow is pending and not expired, the text is that flow's input. A valid input completes
   the flow, sets `last_input_key`, clears the pending state, and re-renders the anchor. An
   invalid input re-asks and keeps the flow pending. **Every flow rejects text that parses as a
   full expense (amount and description)**, re-asking with a hint and [Отмена], unless the flow
   asks for exactly that.
3. Otherwise, parse the text as an expense (Plan 0001). If the parse is not an expense and a
   flow **expired** within the last 24 hours, reply `flowExpired` instead of the help text, and
   clear the expired flow. An expense is always recorded, expired flow or not.

A prompt **edits the anchor** into the question, showing the current value, with an inline
[Отмена] (`flow:cancel`). No `force_reply`, because a message carries only one `reply_markup`,
so an inline [Отмена] and `force_reply` can't coexist, and `editMessageText` can't set
`force_reply`. Starting a flow replaces any pending one. `/cancel`, [Отмена], a menu tap and
**any other command** clear the pending flow. Cancel and completion restore the anchor to the
screen or card the flow started from.

## Consequences

### Positive
- Survives restarts and deploys. A prompt sent before a deploy still works after it, and so
  does a screen's anchor.
- A redelivered answer is idempotent by the same source-key rule as expenses.
- One routing rule for every future flow (categories, edit, settings).

### Negative
- While a flow is pending, a real expense typed by mistake is neither recorded nor consumed. It
  is re-asked with a hint, and the user must tap [Отмена] and send it again. A short answer that
  isn't expense-shaped is still consumed: `Дача` becomes a category name even if the user meant
  something else. Mitigations: the prompt says what it expects and offers [Отмена], and flows
  expire after 10 minutes.
- One pending flow per user. Starting a second flow silently drops the first.
- A user who ignores the prompt and types plain text (not an expense) within a day gets
  "time's up" rather than help. That is correct for a late answer and slightly odd for anything
  else.

## Alternatives considered

### Alternative A: In-memory session (grammY `session()` with the memory adapter)
It needs no table. It lost because every deploy and restart drops pending flows, and nothing
survives to recognise a redelivered answer.

### Alternative B: Match answers only by `reply_to_message` to the prompt
It needs no pending state, and a stray expense is never swallowed. It lost because users
dismiss the reply box or answer without replying, and then the answer is recorded as an expense
or rejected as not-an-expense. It fails in the common case to prevent the rare one.
