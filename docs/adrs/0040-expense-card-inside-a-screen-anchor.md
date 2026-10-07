# ADR-0040: An expense card can be drawn inside a screen anchor, and only there does it carry a back row

> **Status:** proposed
> **Date:** 2026-10-06
> **Related plan(s):** [Plan 0037](../plans/0037-category-drill-down.md)

## Context

ADR-0011 has two kinds of inline message. A **card** is about one expense. Its `exp:*` callbacks
work on any card, however old, and the expense's stored state is the guard. A **screen** lives in
the user's one anchor message, and its callbacks work only on that anchor. Until now the two
never met: a card was always its own message (the confirmation), so it never needed a way "back".

Plan 0037 lets the user go from `/week` or `/month` to a category, then to that period's expenses
in it, then to one expense, so they can fix a misfiled entry without scrolling the chat for its
confirmation. The last step is the expense card itself, and it has to stay inside the summary's
anchor so the user can return to the list. Every `exp:*` handler re-renders the card with
`recordedCard`, `deletedCard` or `cardFor`, which carry no back button. Carrying the way back in
the callback data doesn't fit: `exp:setcat:<uuid>:<id>` already reaches the 64-byte limit for a 16-digit category id (`src/bot/callbackData.ts`).

## Decision

> A card can be drawn into a screen anchor. Its way back lives in the anchor's session row, not
> in its callback data. One helper in `src/bot/handlers/card.ts` decorates every card a callback
> or a flow answer re-renders: if the message being edited is the user's current anchor, and that
> anchor shows this expense inside a summary drill-down, the helper appends `[« Назад]`
> (`drl:back`) on its own bottom row. A viewer who isn't the expense's author gets `[« Назад]`
> alone, because every card action is author-only. A card anywhere else renders exactly as it
> does today.

An edit prompt started from such a card turns the anchor into an `ExpenseScreen` (ADR-0011), as
it does today. The `ExpenseScreen` keeps the summary screen it replaced in an optional `returnTo`.
When the flow ends, the anchor goes back to that summary screen. `drl:back` accepts either form,
so a prompt left to expire still has a way back.

## Consequences

### Positive
- The card in the drill-down is the real card. Category, edit, delete, restore, receipt items and
  repeat all work there with no second implementation.
- Old cards in the chat are untouched, so ADR-0011's "works however old" guarantee stands.
- No callback data grows, and the 64-byte budget of `exp:*` stays as it is.

### Negative
- Every place that re-renders a card in response to a tap or a typed answer has to go through
  the helper. A missed site drops the back row after that action and strands the user on a card
  inside the drill-down. The helper's call sites are a review item, and Plan 0037 pins each one
  with a test.
- Each card re-render reads the session row, one extra indexed read per tap.
- The card's look now depends on where it is drawn, which is one more thing to keep in mind when
  changing `recordedCard`.

## Alternatives considered

### Alternative A: A re-categorise picker in the screen, no card
Tapping an expense in the list opens a category picker in the screen, and picking returns to the
list. It lost because it adds a second category picker beside the card's, and it can't edit or
delete. Once a wrong entry is found, fixing its amount or date is the very next thing the user
wants.

### Alternative B: Send the card as a new message
Tapping an expense in the list replies with that expense's card. The card code wouldn't change
at all. It lost because every tap adds a message to the chat, there's no way back from the card
to the list, and the anchor model exists precisely to avoid a chat full of stale screens.
