# ADR-0011: Navigation: a persistent menu, expense cards, one screen anchor per user

> **Status:** accepted (2026-09-30)
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0007](../plans/done/0007-navigation-shell.md), [Plan 0003](../plans/done/0003-categories.md), [Plan 0004](../plans/0004-dates-edit-summaries.md), [Plan 0005](../plans/done/0005-settings.md)

## Context

The bot is a set of slash commands. Only `/today` and an Undo button exist today, but Plans
0003, 0004 and 0005 add pickers, hubs, pagers and text prompts. Each plan specifies its own back,
cancel and paging behaviour, and some cases not at all. A ux-telegram audit (2026-09-29) found
that the plans already contradict each other: «Назад» is both "back" and a pager label, and
«Отменить» (delete this expense) sits next to «Отмена» (abort this prompt). Some pickers have no
way back. The catch-all callback handler in `src/bot/handlers/undo.ts` swallows every callback
registered after it.

The sibling `traditional-medicine-notifier-bot` hit the same problem at the same stage. It
adopted a small interaction kit from `serbian-language-bot` (its ADR 009, built by its Plan 007):
a persistent reply-keyboard menu, inline drilldown with back buttons, one anchor message edited
in place per flow, and a callback prologue that no-ops stale taps. The model has run in
production there since 2026-06, across a library browser, a reminder wizard and settings.
Navigation is expensive to change once users know the menu and dozens of handlers share its
conventions, so we record it before the first multi-step flow lands.

One force differs from the sibling. Our most important inline message is the **expense
confirmation**, and there are many of them in the chat. Undo on yesterday's confirmation must
still work. The sibling's rule that only the latest anchor accepts taps can't apply to it
unchanged.

## Decision

We port the sibling's model to grammY, with one addition: expense cards.

1. **Persistent menu.** A reply keyboard (`Keyboard` with `.resized().persistent()`) whose
   labels live in `messages.menu`. A menu tap arrives as text. It is matched **exactly** against
   a label and routed to the same entry function as the matching slash command. Menu routing runs
   before flow routing (ADR-0009) and before expense parsing. A menu tap counts as a command: it
   clears any pending flow. The replies to `/start` and `/help` carry the menu. Each plan adds its
   button when its screen lands. The target layout is `[📊 Сегодня] [📅 Неделя] [🗓 Месяц]` /
   `[⚙️ Настройки] [❓ Помощь]`.

2. **Two kinds of inline message.**
   - A **card** is about one expense (the confirmation). Its callbacks are
     `exp:<action>:<uuid>[:<arg>]`, and they work on any card, however old. The expense's stored
     state is the guard: author only, not deleted, category not archived. A card is edited in
     place and never replaced.
   - A **screen** is a hub, picker, summary or prompt: `/categories`, `/settings`, `/week`,
     `/month`. Each user has **at most one screen anchor**, which is stored with ADR-0009's session
     row together with the screen's context (for example the ledger id a summary shows).
     Opening a screen from a command or the menu sends a new message, and that message replaces
     the anchor. A screen callback tapped on any other message gets the `staleScreen` toast and
     changes nothing. A text prompt started from a card makes that card the anchor until the
     flow ends.

3. **One callback dispatcher.**
   - Callback data is `<scope>:<action>[:<arg>…]`, built only through `src/bot/callbackData.ts`,
     which checks the 64-byte limit.
   - Every callback is answered exactly once. The error boundary answers only if the handler
     didn't.
   - An unknown callback falls through to a single fallback, registered last in `bot.ts`, which
     answers it silently.
   - An edit that Telegram rejects as "message is not modified" counts as success.
   - A screen callback first runs `requireScreen(ctx, screen)`, which checks the user and that the
     tapped message is the current anchor.

4. **Navigation conventions.**
   - `[« Назад]` sits alone on the bottom row. Each plan names which screen it returns to.
   - Every text prompt edits its anchor into the question, which shows the current value, with
     `[Отмена]` (`flow:cancel`). Cancelling or completing restores the anchor to the screen or
     card the flow started from.
   - A destructive button gets its own row. «Отменить» is never a button label: deleting an
     expense is `[Удалить]`, and aborting a prompt is `[Отмена]`.
   - A list of more than 8 choices pages 8 at a time with `[◀] [n/N] [▶]`. A period pager names
     the periods (`[◀ Август] [Октябрь ▶]`). «Назад» and «Вперёд» are never pager labels.
   - The current value in a picker is marked `✓ `.

5. **Rendering** goes through the HTML seam (ADR-0012). The menu and buttons are plain labels.

## Consequences

### Positive
- Every feature is one tap from the always-visible menu, with no need to type `/`.
- Plans 0003, 0004 and 0005 reference one set of rules instead of each specifying back, cancel
  and paging. A missing back button becomes a review finding against this ADR.
- Undo, category, edit and restore keep working on old confirmations. Only screens go stale.
- Storing the screen's context with the anchor fixes Plan 0004's open question: a paged summary
  keeps the ledger it was opened for.

### Negative
- The menu bar takes vertical space on the phone, and it is visible while the user types an
  expense.
- Every new screen owes a back route, a stale-tap test and an anchor write. That cost is
  deliberate.
- One screen anchor per user: opening `/settings` kills the pager on an older `/month` message.
  The user gets a toast, and the menu is one tap away.
- A menu label typed by hand (`📊 Сегодня`) is a menu tap, not an expense. Labels must never
  parse as an expense (a test pins this).

## Alternatives considered

### Alternative A: Inline-only `/menu` hub
One message of inline buttons. It lost for the reason the sibling gave: the hub scrolls out of
view, so the user types `/menu` again. The reply keyboard is persistent by construction.

### Alternative B: grammY plugins (`@grammyjs/menu`, `@grammyjs/conversations`)
They give menus and multi-step dialogues for free. They lost on dependency cost and on
idempotency. `conversations` replays handler code against its own stored update log, a second
state model beside ADR-0009's session row, and redelivery dedup would have to be proved against
it. The sibling reaches the same UX with plain handlers and a thin kit.

### Alternative C: The sibling's strict rule for every inline message
Only the latest anchor accepts taps, including expense confirmations. It lost because Undo and
category changes on an older confirmation are the common case, not an edge case.

## Outcome

**2026-09-30, Plan 0007 close.** Decision 3's fallback is not a terminal handler registered last
in `bot.ts`. `callbackDispatcher()` in `src/bot/callbacks.ts` is middleware installed after the
allowlist. It makes a repeat `answerCallbackQuery` on the same update a no-op, and after `next()`
returns it answers silently any query that nothing answered. A terminal catch-all would swallow
every scope registered after it, which is the defect this ADR set out to remove. A later plan
registers its callback handlers anywhere in `createBot`, and they still fire.
