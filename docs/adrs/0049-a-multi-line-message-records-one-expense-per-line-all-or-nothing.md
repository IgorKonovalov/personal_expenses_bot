# ADR-0049: A multi-line message records one expense per line, all or nothing, under one card

> **Status:** proposed
> **Date:** 2026-10-08
> **Related plan(s):** [Plan 0048](../plans/0048-several-expenses-per-message-day-list-more-menu.md)

## Context

Users want to send a day's spending as one message: `450 кофе`, `1200 такси` and `12 eur обед`
on three lines. Today `parseExpenseText` treats a newline as any other whitespace, so
`450 кофе\n1200 такси` records **one** expense of 450.00 with the description «кофе 1200 такси».
Nothing tells the user. A trailing-amount first line (`кофе 450\nтакси 1200`) records nothing.

The same text shape has a legitimate single-expense reading. `450 кофе\nс Ирой` is one expense
whose description wraps, and it records correctly today. Whatever rule splits lines must leave
that case alone.

One expense has always meant one Telegram message: the source key `tg:<chat>:<message>` is the
idempotency key (`expenses.source_key UNIQUE`). The edited-message hint (ADR-0037) and the
ambiguous-amount answer look an expense up by that key. A message that yields several expenses
needs several keys, and those lookups must keep working for the one-line case.

Plan 0046 (approved, not built) has its own multi-line reader, `readMessage`, for imported group
history. It drops a matching total line, splits on `, `/`; ` and has verdicts tuned to messages
nobody is around to fix (`review`, `prefix`, forwarded copies). A live sender is there to fix a
line.

## Decision

> A private-chat text whose non-empty lines number at least two, **and at least two of which read
> as expenses** (the per-line reading `recordExpense` already does with `forms: 'any'`), is a
> multi-line message. It records every line or none. A line that doesn't read as a plain expense
> (unreadable, an ambiguous amount, a future date, a `/N` split, too many tags) refuses the whole
> message, naming that line by number. Fewer than two expense lines keep today's single-expense
> path unchanged. Line 1 keeps the key `tg:<chat>:<message>`, and line *n* ≥ 2 gets
> `tg:<chat>:<message>:<n>`. All lines are stored in one transaction, so a redelivery finds line
> 1's key and re-shows the stored batch. The bot answers with one batch card: the numbered
> expenses, totals per currency, and a number button per expense that opens that expense's normal
> card in place (ADR-0040), with [« Назад] to the batch.

The line limit is 20 (`MAX_EXPENSE_LINES`). Over it, nothing is recorded and the bot says so.

## Consequences

### Positive
- A day's expenses go in with one message and one answer, and every expense is still
  editable from its own card.
- No second parser. Each line is read exactly as a one-line message would be, so currency
  words, amount-last text, dates and tags all work per line.
- All or nothing means a refusal never leaves half a message recorded and no guessing which lines
  went in.
- Single-line keys are unchanged, so the edited-message hint and the ambiguous answer keep
  working for every existing expense.

### Negative
- The service derives the `:<n>` keys from the adapter's base key, a small break of the
  "source key is opaque" rule in `recordExpense`.
- One bad line out of ten refuses all ten. The user has to fix and resend the whole message.
- The ambiguous-amount question isn't asked per line. An `1.500` line is refused with a hint to
  write it unambiguously.
- An edited multi-line message gets no edit hint: its lines 2..n aren't under the plain key. Line
  1 is, so the hint still fires.
- The batch card's number buttons work only while it is the user's screen anchor, as every
  card-in-place list does (ADR-0011). An older batch answers `staleScreen`, and its expenses are
  reached through /today's list (Plan 0048 Phase 2) or /week and /month.

## Alternatives considered

### Alternative A: a normal card per line
Five lines, five confirmation messages. Simplest, since each line reuses the single path whole,
but it floods the chat, which is what the tidy-chat switch (ADR-0038) fights. A refusal halfway
through also leaves the first lines recorded.

### Alternative B: Plan 0046's `readMessage`
Reusing the import reader would give one multi-line grammar. It lost because its rules serve
unattended history: dropping a total line, splitting on commas (which collides with `4,50`), and
`review` verdicts with no live answer. It would also make this feature wait for Plan 0046.

### Alternative C: record the readable lines, report the rest
Partial success is friendlier for one typo. It lost because the user then has to work out which
lines went in before resending, and resending the whole message double-records the good lines
under a new message key.
