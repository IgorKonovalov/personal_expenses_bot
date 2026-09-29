# Telegram constraints that shape a flow

Hard limits and gotchas to check every flow against. The correctness side (asserting limits in
code, idempotency) lives in `.claude/skills/architect/references/best-practices.md`. This file is
about how those limits shape what the user sees.

## Message size

- **Text message: 4096 characters.** Long reports (a month by category, a receipt's line items)
  need a deliberate design: a summary first, with details paged or on demand. Don't let the
  message get truncated.
- **Caption (photo or document): 1024 characters.** An export sent as a document gets a short
  caption, and the details go in the file.

## Inline keyboards and callback data

- **`callback_data` is at most 64 bytes.** It uses `<scope>:<action>:<arg>` with stable ids, never
  display text or amounts. Show the byte math in a design. A UUID arg is 36 bytes, so
  `exp:undo:<uuid>` is 45.
- **Every callback is answered** (`ctx.answerCallbackQuery()`), or the button spinner hangs. A
  stale button (after a restart, a session TTL, or a tap on an old message) acknowledges
  silently or with a short toast, and never errors.
- **Rows of 1 to 3 buttons, with labels of about 20 characters or fewer**, or they wrap on a
  phone. More than about 8 choices means paging or a filter, not one giant keyboard.
- A toast (`answerCallbackQuery({ text })`) is limited to about 200 characters and disappears.
  Use it for "Уже отменено", never for anything the user needs to keep.

## Editing and deleting

- **Edit in place** (`editMessageText` / `editMessageReplyMarkup`) for drilldowns and state
  changes on the same object, such as an Undo that turns the confirmation into "Отменено". Use a
  new message for a new event.
- An edit with identical content returns 400 "message is not modified". It's benign, and the
  adapter swallows it, so a design can re-render freely.
- `editMessageText` works only on text messages. A photo or document (a receipt, an export)
  needs `editMessageCaption` or a new message, so decide which one is the anchor.
- A bot can **delete** its own messages only within **48 hours** in private chats. Undo should
  edit the confirmation rather than delete it.

## Input routing

- **Free text is both the expense entry point and the answer to flow prompts** (rename a
  ledger, type a correction). The design must say how text is routed while a flow is waiting
  for input: the active session claims it, and anything else falls through to expense parsing.
  A prompt that swallows an unrelated `450 кофе` is a bug.
- Commands are matched before the free-text handler. Typing a command mid-flow should leave
  the flow (or cancel it explicitly), not be parsed as input.

## Updates

- **Updates are redelivered** after restarts, so a repeated message must produce the same
  confirmation, not a second expense.
- **Edited messages** arrive as separate `edited_message` updates. Whether editing an expense
  message edits the expense is a plan decision, and until then edits are ignored.

## Groups (shared ledgers)

- With **privacy mode** on (the default), a bot in a group sees only commands, replies to it and
  mentions, not plain `450 coffee`. A "log in the family group" design must choose: turn privacy
  mode off (the bot then reads every message), require a command or reply, or keep logging in
  private chats and post to the ledger. Surface this as a decision for `/architect`.
- In a group, the confirmation is visible to every member, so don't reveal anything personal.

## Formatting

- Whether messages use `parse_mode` is decided once, in the render module. If it's HTML or
  MarkdownV2, **user text (descriptions, ledger names) must be escaped**. A design must never
  assume bold/italics that the render layer doesn't support.

## Commands menu

- `setMyCommands` populates the `/` menu. Keep descriptions short and in the bot's UI language.
  The menu is a discovery surface, so list only the commands a user types regularly.

## Rate limits

- Roughly 1 message/second per chat, 20/minute per group, and about 30/second globally. A flow
  shouldn't answer one user action with a burst of several messages. Combine them into one.
