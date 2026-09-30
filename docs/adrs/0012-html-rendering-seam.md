# ADR-0012: Telegram HTML through one escaping seam

> **Status:** proposed
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0007](../plans/0007-navigation-shell.md)

## Context

Every message is plain text today, and Plan 0003 relies on that ("no `parse_mode` exists, so no
escaping is needed"). Summaries by category (Plan 0004) and settings (Plan 0005) read better
with emphasis: a bold total, a bold header. The user asked for formatting now, before those
plans land, so they are written against it from the start.

The risk is concrete. Descriptions and category names are user text. One unescaped `<` or `&`
in an HTML message makes Telegram reject the whole message with 400, so the confirmation never
arrives and the user can't tell whether the expense was saved. The sibling
`traditional-medicine-notifier-bot` solved this (its ADR 011, after serbian-language-bot's
ADR 008). The fix there is to make "an unescaped string reached a send call" impossible to
write, not merely discouraged.

## Decision

Every outgoing message text is Telegram HTML, and it is minted and sent only through
`src/bot/render/html.ts`.

- `type Html = string & { readonly __brand: 'html' }`. The `html` tagged template escapes every
  interpolated value (`&`, `<`, `>`, `"`) and trusts only the static parts from source. Nested
  `Html` is joined with `joinHtml`, never interpolated, so it can't be escaped twice.
- Every message in `messages.ts` that becomes a message text returns `Html`. Toasts and button
  labels stay plain `string`, because Telegram doesn't parse them.
- `replyHtml(ctx, body, extra)` and `editHtml(ctx, body, extra)` are the only send and edit
  calls that set `parse_mode: 'HTML'`, and `editHtml` treats "message is not modified" as
  success (ADR-0011). ESLint bans the `parse_mode` property and direct `ctx.reply` /
  `ctx.editMessageText` calls everywhere in `src/bot/` outside `render/`.
- Truncation cuts **raw** text by code points before escaping (`shownDescription`). Nothing
  ever slices an `Html` string, so an entity or tag can't be cut in half.
- Formatting stays sparse: bold for amounts in a confirmation, and for headers and totals in a
  summary. Emphasis never carries meaning that the plain words don't.

## Consequences

### Positive
- User text can't break a message. That is a type error and a lint error, not a review
  checklist item.
- Plans 0003, 0004 and 0005 get bold headers and totals without a per-plan decision.
- It is the same seam as the sibling bot, so fixes and tests port directly.

### Negative
- Every message builder changes type, and every send site moves to the helpers: one mechanical
  refactor in Plan 0007.
- Test assertions compare HTML (`<b>450.00 RSD</b>`), not plain text. The harness needs a
  helper for the visible text.
- The 4096 limit applies to the text after entity parsing, so escaped length overstates it.
  Length checks run on the visible text, not on the `Html` string.

## Alternatives considered

### Alternative A: Stay plain text
It needs no escaping at all. It lost because the user chose formatting now, and adding the seam
later means rewriting three plans' message tests.

### Alternative B: MarkdownV2
It needs no tag-closing, but it has 18 reserved characters, including `.` `-` `(` `)` `!`,
which appear in every amount and date. One escaping miss is a 400. HTML reserves three.

### Alternative C: Entities (text plus `entities` offsets, no `parse_mode`)
It can't break on user text, because nothing is parsed. It lost on ergonomics: offsets are
UTF-16 code units, and computing them across Cyrillic, emoji and interpolated descriptions in
every message builder is fiddlier than escaping.
