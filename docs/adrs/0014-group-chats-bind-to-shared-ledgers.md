# ADR-0014: A group chat binds to one shared ledger, and the chat, not the active ledger, routes its messages

> **Status:** accepted (2026-10-01)
> **Date:** 2026-09-30
> **Related plan(s):** [Plan 0009](../plans/done/0009-group-ledgers.md)

## Context

The bot should also work as the accountant for a Telegram group. Any member writes `450 кафе`,
and the bot keeps a shared digest with a per-person breakdown. The same person also keeps
private books in DM with the same bot, and nothing from those may reach the group.

ADR-0002 routes every expense to the sender's `active_ledger_id`. In a group that rule misfiles
by construction. A member whose active ledger is personal would book group spending privately,
and switching the active ledger to the group would book DM spending into the group.

Two per-user stores assume a single conversation. ADR-0009 keeps one pending text flow per user,
and ADR-0011 keeps one screen anchor per user. With group privacy mode off, a user's group
message would reach a DM flow waiting for an amount and be consumed as its answer. The DM
fallbacks (help on any photo, sticker or unknown command) would fire on every bit of group
chatter.

Access is gated today by a sender allowlist (`ALLOWED_TELEGRAM_IDS`). Group members are not on
it, and allowlisting every family member by hand defeats "anyone in the group can record".

## Decision

> A Telegram group or supergroup binds to exactly one `shared` ledger through a
> `ledger_chats(provider, chat_id) -> ledger_id` table. The chat id is an external identity and
> never a key of the ledger. Inside a bound group, **the chat selects the ledger**: every
> expense, report and card uses the bound ledger, and the sender's active ledger is neither read
> nor changed. In DMs, ADR-0002's active-ledger rule stands unchanged.

- **Activation is gated by who adds the bot.** A group is bound only when an allowlisted user
  adds the bot, and it gets a new shared ledger owned by that user. If anyone else adds it, the
  bot leaves the chat. Every member of an active bound group may record, and a first-time sender
  is auto-provisioned (user, identity, personal ledger, `member` row) when their first message
  records an expense. Nothing is stored for a sender whose messages never parse. The DM
  allowlist is unchanged.
- **The adapter splits by chat type.** Group updates go to their own composer. DM handlers,
  ADR-0009 flows, ADR-0011 anchors, the menu keyboard and the help fallbacks never see a group
  update. A group interaction is stateless: callbacks resolve their ledger through the chat
  binding. Multi-step edits of a group expense happen in the author's DM, reached by a deep link,
  so they're open only to an allowlisted author. A member who isn't allowlisted deletes the
  expense from the group card and records it again. Allowlisting them opens DM in full.
- **Group expenses are edited only by their author**, in the group card and in DM alike.
- **Privacy is enforced by routing:** output about a ledger goes only to chats bound to it and to
  its members' DMs. Output about a personal ledger goes only to its owner's DM. Future budgets,
  alerts and scheduled posts inherit this rule.

This partially supersedes ADR-0002: its routing rule ("every expense goes to the active ledger")
now applies to DMs only. The rest of ADR-0002 stands.

## Consequences

### Positive
- One person keeps private books and a family book in the same bot, and which chat they write
  in decides which book an expense lands in. No per-message question, no switching.
- Group members need no setup. The first parseable message makes them a member.
- Group code can't corrupt DM state, because the split is structural (separate composers), not a
  set of `if (chat.type …)` checks spread through handlers.
- Budgets, notifications and digests have a ready answer to "where does this message go?".

### Negative
- Privacy mode must be off (a BotFather setting), so the bot receives every group message.
  Unparseable chatter is dropped without storage, but it still reaches the process.
- Chatter that happens to start with a number (`2 минуты буду`) records a false expense. The
  quiet-confirmation rule (Plan 0009) makes such rows visible, but doesn't prevent them.
- Two code paths for the same user actions (the DM card vs the group card) that must agree on the
  service-level rules: author-only edits and soft delete.
- A group ledger is not reachable from DM reports until a ledger switcher exists.
- The chat binding is a new failure surface: supergroup migration changes the chat id, and a
  kicked bot leaves a dangling binding. Both need explicit handling.

## Alternatives considered

### Alternative A: A separate `group` ledger kind reachable only from its chat
It's simpler to explain ("the group's books live in the group"). It lost because it forks the
membership model. A family that also wants the book in DM reports would need a migration from
`group` to `shared`, and every repository query would grow a kind check.

### Alternative B: Group messages go to each author's active ledger
It needs almost no schema change. It lost because it isn't a group accountant: there's no shared
digest, no per-person breakdown, and it breaks the privacy requirement whenever a member's
active ledger is personal.

### Alternative C: Keep gating every group sender by the allowlist
It gives the tightest control. It lost because every family member would have to be allowlisted
by hand, which contradicts "anyone in the group can record". Gating the act of adding the bot
keeps the same trust boundary (an allowlisted person vouches for the group) with no per-member
setup.
