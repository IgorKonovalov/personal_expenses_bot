# ADR-0038: Long lists collapse in Telegram's expandable quote, and the user's recorded messages are deleted only when they opt in

> **Status:** proposed
> **Date:** 2026-10-06
> **Related plan(s):** [Plan 0035](../plans/0035-collapsed-lists-period-items-tidy-chat.md)

## Context

A fetched receipt opens into a list of items that can run to dozens of lines. A month summary
has a line for each category. Once the user scrolls back through the chat, these long messages
bury everything else. The user's own messages add to the clutter: every `450 кофе`, receipt link
and pasted bank SMS stays above the card that now stands for it. The user asked for a way to
hide the information they don't need at the moment.

Telegram gives bots three ways to make a message take up less room. Since Bot API 7.4, the HTML
tag `<blockquote expandable>` renders as a quote that shows its first few lines, and a tap on it
expands or collapses it in the client, with no update sent to the bot. A bot can also edit its
own message into a shorter form, or delete it. In a private chat, a bot can delete the user's
messages for up to 48 hours after they were sent.

Deleting what the user typed can't be undone. Plan 0034 already deletes a receipt photo once its
card is recorded, because the photo carries nothing the card doesn't. A typed message is
different: it is the user's own words, and some people want to keep them.

## Decision

> A long list inside a bot message is wrapped in `<blockquote expandable>`. This covers a receipt
> card's items, the category lines of `/week` and `/month`, and each category's items in the
> period items view. Collapsing and expanding happen in the Telegram client: no button, callback
> or stored state. A per-user `tidy_chat` switch in `/settings`, off by default, makes the bot
> delete, in a private chat only, the message the user sent once it has recorded an expense:
> a typed expense, a receipt link or a bank SMS. A message that recorded nothing is never deleted.

## Consequences

### Positive
- Collapsing costs no round trip and survives restarts and redeliveries, because there is no
  state to lose.
- Old messages in the history are short by default. The user expands only the one they want.
- Nobody loses their own text unless they asked for that. The card keeps the description and the
  amount the bot recorded.

### Negative
- The client decides how many lines a collapsed quote shows, and the bot can't choose them. A
  client too old to know the tag shows the whole quote, so that case is no worse than today.
- A quote starts collapsed every time the message is rendered. Someone who wants the list open
  has to tap it.
- Messages that already exist keep their old look until something re-renders them.
- With `tidy_chat` on, the user's original text is gone. If the parse was wrong, they see only
  what the bot understood. The editing hint (ADR-0037) also stops applying, because there is no
  message left to edit.
- A second per-user switch (after `tips_off`) adds a migration and a `/settings` row.

## Alternatives considered

### Alternative A: a [Скрыть] / [Показать] button that edits the message
This works in every client and the bot controls exactly what stays visible. But every tap is a
round trip to the bot. Each message needs a callback and a re-render of its short form, and
every long message gains a button row. The expandable quote does the same thing on the client
alone.

### Alternative B: a "clear the chat" button that deletes the bot's recent messages
This is the most thorough cleanup. It only reaches messages under 48 hours old, so older
clutter stays. It also destroys cards that hold [Удалить] and [Категория], which the user still
needs.

### Alternative C: always delete the user's recorded messages
This is the cleanest chat, and it extends what Plan 0034 does with receipt photos. It lost
because it can't be undone and changes how the chat looks for everyone. A setting keeps that
choice with the user.

## Outcome

_(Added only at acceptance if implementation falsified something above.)_
