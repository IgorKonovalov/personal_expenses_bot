# ADR-0047: A group's history from before the bot joined is imported from a Telegram Desktop JSON export, read by rules and reviewed before recording

> **Status:** accepted
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0046](../plans/done/0046-group-history-import.md)

## Context

A family group kept its expenses as chat messages for months before the bot joined. A bot can't
read a chat's history: the Bot API delivers only the updates sent after the bot joined. So the
backlog has to reach the bot some other way, with each message's original date and sender, which
per-person totals and debts depend on.

The messages are free-form. One message can hold one expense, several items on separate lines with
a total line, or comma-separated items in different currencies. Some start with another person's
name («Ира: ремонт 300€»). Some are chatter that ends in a number. No reader gets all of them
right, so a person has to see what will be recorded before it is.

Expense text is private (CLAUDE.md). It stays on the server and out of logs above debug.

## Decision

The owner exports the group's history from Telegram Desktop as JSON (Export chat history → JSON,
with no media) and sends the `result.json` file to the bot in a private chat. The bot matches the
export to the group's bound shared ledger. It reads only the messages sent before the binding, and
splits each one into items with rules in the domain layer (Plan 0046's reader). Then it answers
with a preview:

- **Ready messages** are those whose every line resolved to an item or a matching total. One
  button records all of them.
- **The rest** come one card at a time: [Записать так], [Исправить] (send corrected lines) or
  [Пропустить].

Each item is recorded under the message's sender, or the person a name prefix maps to (asked once
per distinct prefix), on the message's original date. Its source key comes from the chat and the
message, so sending the file again records nothing new.

The import's state (the read messages, each message's decision, the prefix mappings) is kept for
24 hours after the last tap, apart from the user's pending-flow slot, so using the bot meanwhile
doesn't end a long review. Re-sending the same export inside that window keeps the decisions.

The group gets one notice naming the importer and the count, with no amounts or text, edited in
place as the count grows. Members see why their totals changed.

[Отменить импорт], after a confirm step, deletes every expense the chat's import recorded. The
delete is permanent, and the file is the backup: sending it again records them again.

## Consequences

### Positive
- The whole backlog arrives in one upload, with true dates and senders.
- The reader is deterministic and offline, and its unit tests use synthetic messages.
- Live and imported text share one parser (ADR-0046).

### Negative
- An export needs Telegram Desktop. The mobile apps can't export.
- The export format isn't a documented API. The fields the plan relies on (`id`, `messages[].id`,
  `date_unixtime`, `from`, `from_id`, `text`) are stated from the format as known at planning time.
  They are unverified until the human phase reads a real export.
- Rules miss some wordings. Those go to review, which is hand work proportional to how messy the
  chat was.
- Senders who never started the bot get a user row and shared-ledger membership, as they would by
  writing an expense in the group after the bot joined (ADR-0014).
- The read messages, chatter included, are stored server-side for up to 24 hours after the last
  tap, not only held in memory.
- An undone import is gone from the database. It comes back only from the file.

## Alternatives considered

### Alternative A: forward the old messages into the group
A forward carries `forward_origin` with the original date and sender, and it works from a phone.
It was rejected because months of messages would be forwarded by hand and would fill the chat. A
forward from a member with hidden forwarding also loses its sender.

### Alternative B: paste the text into the private chat
This is the simplest option, but it was rejected because copied text loses each message's date and
sender, and those are what make the backlog worth importing.

### Alternative C: Claude API reads the messages
This handles almost any wording. It was rejected because it sends private expense text off the
server, adds a dependency, an API key and a per-import cost, and its results can't be pinned by
unit tests. Review would still be needed.

### Alternative D: undo an import with a soft delete
This is the house pattern for a single expense (an [Удалить] that [Вернуть] restores). It was
rejected for the import because a source key stays unique on a soft-deleted row, so the file could
never be imported again after an undo, and an undo is most often followed by a corrected re-import.
