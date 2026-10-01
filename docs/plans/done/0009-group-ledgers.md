# 0009: Group ledgers: the bot as a group's accountant, with personal books kept private

> **Status:** done (2026-10-01): built as planned, one minor open (DM edits of a group expense
> use the viewer's timezone), Phase 5 live check owed, v0.7.0
> **Created:** 2026-09-30
> **Related ADRs:** [ADR-0014](../../adrs/0014-group-chats-bind-to-shared-ledgers.md),
> [ADR-0015](../../adrs/0015-shared-ledgers-carry-a-timezone.md)

## TL;DR

An allowlisted user adds the bot to a Telegram group, and the group gets its own shared ledger.
Any member writes `450 кафе` in the group, and it's recorded in that ledger under their name. The
bot confirms with an emoji reaction, or with a small card when it's unsure. `/week` and `/month`
in the group show totals by category and by person. Everything a member writes in DM stays in
their personal ledger and never appears in the group. The first thing the user sees: they add
the bot to the family group, write `450 кафе`, and the bot answers there.

## Context & problem

The bot keeps one person's books in DM. The user wants a second mode, where the bot sits in a
group (the family) and every member can record, while the same person keeps private books and
budgets in DM. The schema already has `shared` ledgers with members (ADR-0002), but nothing
creates one. Every piece of the adapter also assumes a private chat:

- `recordExpense` always writes to the sender's active ledger.
- ADR-0009 flows and ADR-0011 anchors are keyed per user, so a pending DM flow would consume a
  group message as its answer (`routeText` in `src/bot/handlers/text.ts`), and
  `clearFlowOnCommand` would cancel a DM flow whenever the user typed `/month` in the group.
- `registerNonText`, `registerUnknownCommand` and the `notExpense` branch reply with help. With
  privacy mode off, that means a reply to every sticker and every other bot's command in the
  group.
- The sender allowlist drops every group member who isn't allowlisted.
- Period math runs in the viewer's timezone, so a group has no single month edge.

## Decision

Bind a group chat to one shared ledger and route group updates through a separate composer that
never touches DM state (ADR-0014). Give shared ledgers their own timezone (ADR-0015). Gate
groups by who adds the bot, auto-provision members on their first recorded expense, and confirm
quietly: a reaction when the category was recognised, a reply card when it fell through to
«Другое». Group expenses are edited by their author only: deletion happens in the group, and
everything else in the author's DM via a deep link.

We rejected a group-only ledger kind (it forks the membership model), routing group messages to
each author's active ledger (no shared digest, and it leaks), and allowlisting every group
member (friction that contradicts "anyone can record"). See ADR-0014.

## Architecture diagram

```mermaid
flowchart LR
    subgraph Telegram
        U[update]
    end
    subgraph adapter[bot adapter]
        G{chat type}
        DM[DM composer: allowlist, flows, anchors, menu]
        GR[group composer: binding gate, stateless]
    end
    subgraph services
        RE[recordExpense target = active or ledger]
        GM[groupChats: bind, join member]
        PS[periodSummary + byAuthor]
    end
    subgraph db
        LC[(ledger_chats)]
        L[(ledgers.timezone)]
        E[(expenses)]
    end
    U --> G
    G -- private --> DM --> RE
    G -- group/supergroup --> GR
    GR --> GM --> LC
    GR --> RE --> E
    GR --> PS --> E
    RE --> L
```

## Implementation phases

Phases 1 to 4 are dev work in one session, one commit each. Phase 5 is the user's live check.

### Phase 1: Walking skeleton: bind a group, record into it

- **Owner skill:** dev
- **What:** Migration `0007_group_chats.sql`, and a group composer, split off by chat type,
  that binds a group when an allowlisted user adds the bot. It records parseable messages from
  any sender into the bound ledger, in the ledger's timezone, and replies with a plain-text
  confirmation (no buttons yet). Unbound groups, chatter and non-text messages get no reply.
- **Files touched:** `src/db/migrations/0007_group_chats.sql`, `src/db/ledgerChats.ts` (+ test),
  `src/db/ledgers.ts` (timezone, display name), `src/services/groupChats.ts` (+ test),
  `src/services/recordExpense.ts` (+ test: an explicit target ledger, effective timezone),
  `src/services/provisionUser.ts` (initial timezone), `src/bot/bot.ts` (chat-type split; allowlist
  and `clearFlowOnCommand` DM-only), `src/bot/group/index.ts`, `src/bot/group/activation.ts`,
  `src/bot/group/text.ts`, `src/bot/middleware/allowlist.ts`, `src/bot/messages.ts`,
  `src/bot/testHarness.ts` (group updates, `my_chat_member`), `src/bot/group/group.test.ts`.
- **Done when:** in `src/bot/group/group.test.ts`, with A = `ALLOWED_ID` (timezone
  `Europe/Belgrade`, personal ledger in RSD), B = `STRANGER_ID` (never DMed the bot) and group
  chat `-100500` titled `Семья`:
  - A `my_chat_member` update in which A adds the bot creates exactly one `shared` ledger named
    `Семья`, with `default_currency = 'RSD'`, `timezone = 'Europe/Belgrade'`, A as `owner`, and
    one active `ledger_chats` row. The bot sends one welcome message to `-100500`.
  - The same update with B as the adder calls `leaveChat(-100500)` and creates no ledger and no
    binding.
  - B's `300 такси` in the bound group creates B's user (timezone `Europe/Belgrade`), identity,
    personal ledger and `member` row. It records `amount_minor = 30000`, `currency = 'RSD'` in
    the group ledger, `created_by` B. B's `active_ledger_id` is B's personal ledger.
  - A's `450 кафе` in the group records 45000 RSD in the group ledger. A's `active_ledger_id` is
    unchanged, and A's DM `/today` doesn't list it.
  - **Group dates use the ledger's timezone:** SECOND_ALLOWED_ID, whose own timezone is
    `America/New_York`, sends `500 такси` in the group with message date
    `2026-09-30T23:30:00Z`. That gives `occurred_on = '2026-10-01'` (Belgrade, CEST UTC+2:
    01:30). The same text at the same instant in their DM gives `'2026-09-30'` in their personal
    ledger (EDT UTC-4: 19:30).
  - **DM state is untouched by group traffic:** A has a pending DM edit-amount flow. A's
    `450 кафе` in the group records a group expense, and A's `flow_sessions` row (kind, payload,
    anchor) is byte-for-byte unchanged. A's `/month` in the group leaves the flow pending.
  - `привет всем` from a third sender C in the bound group makes no API call and creates no
    user row for C. A sticker, a photo, and `/start@other_bot` make no API call.
  - Any text in an unbound group (the bot added by nobody we know, or before binding) makes no
    API call and creates no user.
  - Redelivering B's `300 такси` update leaves one row (the source key is
    `tg:-100500:<message_id>`).
  - Messages carrying `sender_chat` (anonymous admins, linked channels) and from `is_bot` senders
    make no API call.

### Phase 2: Quiet confirmation and the author-only group card

- **Owner skill:** dev
- **What:** A recognised category gets an emoji reaction and no message. A fallback category
  («Другое») gets a reply card with [Удалить] and [Изменить в личке]. Replying `/card` to a
  recorded message shows its card. [Удалить]/[Вернуть] work for the author only. [Изменить в
  личке] deep-links to the author's DM card, and the card shows it only when the author is
  allowlisted: the DM allowlist stays closed (ADR-0014), so a member who isn't allowlisted
  deletes and records again. The service layer rejects edits to a shared-ledger expense by
  anyone but its author, on every path.
- **Files touched:** `src/bot/group/text.ts`, `src/bot/group/card.ts` (+ test),
  `src/bot/callbackData.ts` (`grp:del:<id>`, `grp:res:<id>`), `src/bot/handlers/start.ts`
  (deep-link payload `e_<expenseId>`), `src/services/recordExpense.ts` (return whether the
  category was the fallback; author check in undo/restore/edit for shared ledgers),
  `src/services/changeCategory.ts` (author check), `src/bot/bot.ts` (hands the allowlist to the
  group composer), `src/bot/messages.ts`, `src/bot/group/group.test.ts`.
- **Done when:**
  - A's `450 кафе` in the group results in exactly one `setMessageReaction` on that message
    (the emoji comes from `messages`) and zero `sendMessage` calls.
  - B's `2 минуты буду` records 200 RSD under «Другое» and replies to that message with a card
    showing `2.00 RSD`, the author's display name and [Удалить], and no [Изменить в личке],
    because B (`STRANGER_ID`) isn't allowlisted. A's `5 минут буду` gets a card with both
    [Удалить] and [Изменить в личке].
  - When `setMessageReaction` rejects (reactions disabled in the chat), the bot sends the reply
    card instead, and the expense is recorded once.
  - A taps [Удалить] on B's card: the toast is `messages.groupNotAuthor`, and `deleted_at`
    stays `NULL`. B taps it: the row is soft-deleted and the card shows [Вернуть]. B's second
    tap on the stale [Удалить] leaves the same `deleted_at`.
  - The [Изменить в личке] URL is `https://t.me/<bot username>?start=e_<expenseId>` (payload
    38 bytes, under Telegram's 64). In DM, A's `/start e_<A's group expense id>` opens the
    ADR-0011 expense card for that expense. A's `/start e_<B's expense id>` gets the plain
    welcome and no card. B's `/start e_<B's expense id>` in DM is dropped by the allowlist and
    makes no API call.
  - A direct service call `undoExpense` / category change / amount edit by A on B's group
    expense returns a not-author result and writes nothing. Personal-ledger behavior is
    unchanged (the existing tests still pass unmodified).
  - Replying `/card` to B's recorded message shows its card. Replying `/card` to a message that
    recorded nothing makes no API call.
  - Every `grp:` callback datum is at most 64 bytes, asserted through `assertCallbackData`.

### Phase 3: Group reports with a per-person breakdown

- **Owner skill:** dev
- **What:** `/today`, `/week` and `/month` in a bound group report on the group ledger in its
  timezone. They add a per-person section after the category breakdown, and page statelessly
  (the ledger comes from the chat binding, not an anchor). The group gets its own `/help` text
  and its own command list (`BotCommandScopeAllGroupChats`). Member display names are stored
  from the sender's Telegram first name and rendered through the ADR-0012 escaping seam.
- **Files touched:** `src/domain/aggregate.ts` (+ test: by-author sums per currency),
  `src/services/periodSummary.ts` (+ test: effective timezone, author lines),
  `src/services/todaySummary.ts` (effective timezone), `src/bot/group/summary.ts`,
  `src/bot/group/help.ts`, `src/bot/bot.ts` (group command scope), `src/bot/messages.ts`,
  `src/bot/group/group.test.ts`.
- **Done when:** with the clock at `2026-10-15T10:00:00Z`, the group ledger holds A's
  `450 кафе` (45000) and `1200 продукты` (120000) and B's `300 такси` (30000), all in October.
  A's personal ledger holds `999 секрет` (99900) on `2026-10-10`. Then:
  - `/month` in the group shows RSD total `1 950.00 RSD` (45000 + 120000 + 30000 = 195000),
    the category lines as in DM, and per person A `1 650.00 RSD` (45000 + 120000 = 165000) and
    B `300.00 RSD`. No part of the message contains `999` or `секрет`.
  - A's `/month` in DM shows `999.00 RSD` and none of the group's rows.
  - The per-person section lists each currency separately for a member who spent in two
    currencies. It never adds across currencies (state the property in the test, since ADR-0003
    conversion is not in scope here).
  - B taps the group `/month` pager: the same message is edited to September, and no
    `flow_sessions` row is written for B.
  - The expense from Phase 1 at `2026-09-30T23:30:00Z` (`occurred_on 2026-10-01`) counts in
    October's group `/month`, not September's.
  - A member whose first name is `<b>Ира</b>` is shown as literal text (escaped), not bold.
  - `/help` in the group sends the group help text, and never the DM menu keyboard.

### Phase 4: Group lifecycle and ledger settings

- **Owner skill:** dev
- **What:** Removing the bot deactivates the binding without deleting anything. Re-adding it
  (allowlisted user) reactivates the same ledger. A supergroup migration moves the binding to
  the new chat id. The ledger owner's `/settings` in the group answers with a DM deep link to a
  settings screen scoped to that ledger (timezone and currency, reusing the Plan 0005 pickers).
  Non-owners get a one-line refusal.
- **Files touched:** `src/bot/group/activation.ts`, `src/services/groupChats.ts` (+ test),
  `src/db/ledgerChats.ts`, `src/bot/group/settings.ts`, `src/bot/handlers/settings.ts`
  (ledger-scoped variant), `src/services/flowSessions.ts` (+ test: the ledger id in the settings
  screen and the timezone flow), `src/bot/callbackData.ts` (ledger-scoped `set:*` data),
  `src/bot/flows.ts` ([Другой…] answers here), `src/bot/handlers/start.ts` (payload `gs_<ledgerId>`),
  `src/services/settings.ts` (+ test: set a ledger's timezone, owner only),
  `src/db/ledgers.ts`, `src/bot/messages.ts`, `src/bot/group/group.test.ts`.
- **Done when:**
  - A `my_chat_member` update with status `left` or `kicked` sets the binding inactive. A later
    `450 кафе` in that chat makes no API call and records nothing. The ledger and its expenses
    are unchanged.
  - A re-adding the bot reactivates the same `ledger_chats` row and ledger (the count of shared
    ledgers owned by A stays 1). B re-adding it after a kick makes the bot leave.
  - A message with `migrate_to_chat_id = -100999` from `-100500` moves the binding. B's next
    `300 такси` in `-100999` lands in the same ledger.
  - A's `/settings` in the group replies with `https://t.me/<bot>?start=gs_<ledgerId>`
    (39 bytes of payload). B's gets `messages.groupSettingsOwnerOnly`.
  - After A sets the group ledger's timezone to `America/New_York` through that screen, A's
    own `users.timezone` is unchanged. A group message dated `2026-10-20T02:00:00Z` records
    `occurred_on = '2026-10-19'` (EDT 22:00). Rows recorded earlier keep their `occurred_on`.
  - B's `/start gs_<ledgerId>` in DM opens no settings screen.
  - README (group section: how to add the bot, BotFather privacy note), `/help` and
    `.env.example` (if anything changed) describe the group mode.

### Phase 5: Live check in the family group

- **Owner skill:** human
- **Blocks merge:** no
- **What:** Configure BotFather and run the flow in a real group.
- **Files touched:** none.
- **Done when:** In BotFather, `/setjoingroups` is Enabled and `/setprivacy` is Disabled, and the
  bot is removed from and re-added to the group, because a privacy change only applies to groups
  joined after it. In the family group, a recognised expense gets a reaction and `2 минуты буду`
  gets a card. The spouse's first expense records under their name. The group's `/month` shows
  both people, and your DM `/month` shows only your personal rows.

## Data shapes

```sql
-- illustrative: 0007_group_chats.sql
ALTER TABLE ledgers ADD COLUMN timezone TEXT;          -- NULL for personal (ADR-0015)
ALTER TABLE ledger_members ADD COLUMN display_name TEXT; -- the member's Telegram first name
CREATE TABLE ledger_chats (
  provider TEXT NOT NULL,                  -- 'telegram'
  chat_id TEXT NOT NULL,                   -- external identity, never a ledger key
  ledger_id TEXT NOT NULL UNIQUE REFERENCES ledgers(id),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  bound_by TEXT NOT NULL REFERENCES users(id),
  bound_at TEXT NOT NULL,
  PRIMARY KEY (provider, chat_id)
);
```

SQLite can't add a `CHECK (kind = 'personal' OR timezone IS NOT NULL)` through `ALTER TABLE`.
`groupChats` enforces it in code, and a repository test asserts that a shared ledger without a
timezone can't be inserted through `insertLedger`.

```ts
// illustrative
type RecordTarget = { kind: 'active' } | { kind: 'ledger'; ledgerId: LedgerId };
// callback data: 'grp:del:<uuid>' / 'grp:res:<uuid>' = 44 bytes
// deep links:    'e_<uuid>' = 38 bytes, 'gs_<uuid>' = 39 bytes (limit 64, [A-Za-z0-9_-])
```

## Risks & open questions

- **False positives from chatter.** `2 минуты буду` is a valid expense to the parser. The
  fallback-category card makes it visible with a one-tap delete. If the family finds this noisy,
  the next lever is requiring a known category word or currency in groups. That's a product call
  after Phase 5, not now.
- **Privacy.** Group routing never reads the active ledger, and group reports read only the
  bound ledger. Phase 3 asserts that the group `/month` text doesn't contain a personal
  description. Display names and chat titles are user data: no info-level logs of them, and
  fixtures use invented names.
- **Idempotency.** The source key already includes the chat id. Group card taps are idempotent
  by soft-delete state. The reaction is a presentation detail: redelivery may re-react, which is
  harmless.
- **Time.** Ledger timezone changes don't rewrite history (ADR-0015). The DST boundaries in
  the done-whens are CEST (UTC+2) and EDT (UTC-4) in late September and October 2026, both
  before the 2026-10-25 and 2026-11-01 switches.
- **Telegram limits.** Reactions may be disabled per chat (fallback: the card). Bots can only
  use the standard reaction emoji. The `/card` command name and the reaction emoji are
  provisional, so a `ux-telegram` review of the group copy is worth running before `go`.
- **Prod shares the dev bot token** (Plan 0002). The BotFather privacy change affects both.

## What this plan does NOT do

- **Budgets** (overall monthly cap + optional per-category caps, per ledger): the next plan.
- **Notifications**: budget threshold alerts, scheduled daily/weekly/monthly summaries
  (including the scheduled group digest), the reminder to log, and recurring expenses. A plan
  after budgets, with a scheduler ADR.
- **Bank SMS parsing** (paste first, phone automation later) and **Serbian fiscal receipt QR**
  (with a total-only fallback): later plans, in that order.
- Binding an existing shared ledger to a group (`/bind`): no shared ledger can exist today except
  through a group, so there's nothing to bind.
- A DM ledger switcher, or DM reports on the group ledger.
- Settle-up / who owes whom.
- Changing a group expense's category from inside the group (a stateless category picker can't
  fit a category UUID and an expense UUID in 64 bytes). It's done in DM via [Изменить в личке].
- DM access for a group member who isn't allowlisted (ADR-0014). They delete and record again,
  or the owner adds them to `ALLOWED_TELEGRAM_IDS`.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: bind a group, record into it | dev | done | 1f014da |
| 2: Quiet confirmation and the author-only group card | dev | done | 74800f8 |
| 3: Group reports with a per-person breakdown | dev | done | 7848f4a |
| 4: Group lifecycle and ledger settings | dev | done | 6f35073 |
| 5: Live check in the family group | human | owed | |

### Notes

- Phase 1: files changed outside `Files touched`: `src/db/ledgers.test.ts` and
  `src/db/categories.test.ts` (their shared-ledger fixtures now carry a timezone, since
  `insertLedger` refuses a shared ledger without one; the repository assertion for that refusal
  is in `src/db/ledgers.test.ts`), and `src/db/connection.test.ts` (it pinned the migration list
  `0001`..`0006`; it now derives the list from the migrations directory).
- Phase 1: `src/services/provisionUser.ts` gained no parameter. A first-time group sender gets the
  ledger's timezone through the existing `defaultTimezone` input, passed by `groupChats`.
- Phase 1: the group confirmation reuses `messages.expenseRecorded`, as a reply to the message.
  A redelivered group message is not confirmed again.
- Phase 1: a group text that parses as ambiguous (`1.200 обед`), invalid or future-dated records
  nothing and gets no reply, like chatter. Followup, not acted on.
- Phase 2: `src/bot/group/index.ts` changed outside `Files touched`: it registers the group card
  handlers and the callback dispatcher on the group composer. `src/bot/bot.ts` is unchanged: the
  group composer already received the allowlist in Phase 1.
- Phase 2: the author checks in `undoExpense`, `restoreExpense`, `changeCategory` and the edit
  service (`src/services/editExpense.ts`) existed before this phase for every ledger kind, and
  their not-author result is `forbidden`. No service check was added; the done-when is asserted by
  tests calling `undoExpense`, `changeCategory`, `openEdit` and `startEdit` (amount).
- Phase 2: `src/services/recordExpense.ts` also gained `findTelegramUser`, a lookup without
  provisioning, so a group tap by someone who never recorded creates no user.
- Phase 2: the group card names the author by the Telegram first name from the update (the
  sender, the tapper, or the `/card` reply's `reply_to_message.from`), not the stored display
  name. The `/card` card replies to the expense's message, not to the `/card` message.
- Phase 3: files changed outside `Files touched`: `src/bot/group/index.ts` (registers the group
  summary and help handlers) and `src/bot/bot.test.ts` (the boot registration test now expects
  the second `setMyCommands` call, scoped to `all_group_chats`).
- Phase 3: group reports read the ledger through its chat binding, with the binder (`bound_by`,
  the owner) as the member the repository's membership join checks, so a viewer who never
  recorded sees the report and is not provisioned. `src/services/periodSummary.ts` reads
  `src/db/ledgerChats.ts` for this.
- Phase 3: group `/today` also carries the per-person section. Display names were already
  stored and refreshed by Phase 1's `joinMember`; no change there.
- Phase 4: files changed outside `Files touched`: `src/bot/group/index.ts` (registers the group
  `/settings` handler) and `README.md` (the group section the done-when names). `.env.example`
  is unchanged: no variable changed.
- Phase 4: the ledger scope travels in the anchor's settings screen (`ledgerId`) and in the
  `setTimezone` flow, not in new callback data: the existing `set:*` data is reused unchanged,
  so `src/bot/callbackData.ts` is untouched.
- Phase 4: re-adding the bot to a group whose binding was inactive sends the group welcome again.
- Phase 4: the DM `/help` text gained a paragraph on the group mode; the group `/help` and the
  group command list gained `/settings`.
- Phase 4: B's `/start gs_<ledgerId>` in DM is dropped by the allowlist before any handler
  (asserted: no API call). The owner-only refusal of the scoped screen is asserted with
  SECOND_ALLOWED_ID, a group member who isn't the owner: plain welcome, no settings anchor.
- Followup, not acted on: after a supergroup migration, `/card` replied to a message sent before
  it finds nothing, because that expense's source key carries the old chat id.

### Close triggers

- **What shipped:** Phases 1 to 4: group binding and recording (1f014da), reaction or author-only
  group card with the `e_` deep link (74800f8), group `/today` `/week` `/month` with a per-person
  section, group `/help` and the group command list (7848f4a), binding deactivation,
  reactivation and migration, and the group `/settings` link to a ledger-scoped DM settings
  screen (6f35073).
- **User-visible surface changed:** in groups: the welcome, ✍ reactions, the group card with
  [Удалить] / [Вернуть] / [Изменить в личке], `/card`, `/today`, `/week`, `/month` with
  «По участникам», `/help`, `/settings`, and a group command list registered with
  `setMyCommands` scope `all_group_chats`. In DM: `/start e_<id>` opens the author's card,
  `/start gs_<id>` opens the ledger-scoped settings for its owner, and `/help` gained a
  paragraph on the group mode. README gained an «In a group» section.
- **Gate at the tip (6f35073):** `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` exit 0,
  42 files, 570 tests passed; `pnpm build` exit 0; `node scripts/check-doc-links.mjs` exit 0,
  125 relative links resolve.
- **Outstanding `human` phases:** Phase 5 (live check in the family group, BotFather
  `/setjoingroups` and `/setprivacy`), not started.

## Close review

Closed 2026-10-01 by the conductor after review round 1 (tip 7dc6064). There was no fix round, so
no earlier finding was resolved by a fix commit. Phase 5 (`human`, `Blocks merge: no`) stays
**owed**: the BotFather `/setjoingroups` and `/setprivacy` settings and the live check in the
family group are not done, so the plan is not verified live. Minor 1 and the nit stay open; minor 1
is copied to `## Followups`. The round 1 review, in full:

> # Plan 0009 review, round 1 (tip 7dc60644f574c39bf491ddceebd67be5376c2602)
>
> **Verdict:** Clean. Phases 1 to 4 deliver what the plan asked for, every named done-when has a test
> whose assertion matches the claim, and the gate is green. There are no blockers and no majors.
> One minor finding: the DM edit paths still date a group expense in the viewer's timezone, not the
> ledger's. One nit. Both can go to followups.
>
> ## Gate (run in this session, at the tip)
>
> - `pnpm typecheck`: exit 0.
> - `pnpm lint`: exit 0.
> - `pnpm test`: exit 0, 42 files and 570 tests passed.
> - `node scripts/check-doc-links.mjs`: exit 0, 125 relative links resolve.
>
> ## Alignment
>
> - The implementation log maps phases 1 to 4 to commits 1f014da, 74800f8, 7848f4a and 6f35073.
>   Phase 5 (`human`, `Blocks merge: no`) is owed. Each phase has exactly one in-vocabulary owner
>   tag. The log is shorter than the phases section and discloses every file changed outside
>   `Files touched`.
> - I read every done-when's assertion in `src/bot/group/group.test.ts`, then the service tests:
>   `groupChats.test.ts`, the target-ledger block in `recordExpense.test.ts`, `summarizeByAuthor`
>   in `aggregate.test.ts`, `groupPeriodSummary` in `periodSummary.test.ts`, `setLedgerTimezone`
>   in `settings.test.ts`, the settings-screen and timezone-flow round trips in
>   `flowSessions.test.ts`, and the `insertLedger` refusal in `ledgers.test.ts`. The assertions are
>   exact payload or row equalities, not "non-empty". The arithmetic matches the plan:
>   195000 = 45000 + 120000 + 30000, A 165000, and the `2026-09-30T23:30:00Z` instant gives
>   Belgrade `2026-10-01` and New York `2026-09-30`. The two-currency property is stated in the
>   test comment, as the plan required.
> - Phase 2 "existing tests pass unmodified": the pre-existing tests that changed were fixture
>   timezones on shared ledgers (`categories.test.ts`, `ledgers.test.ts`), the migration list in
>   `connection.test.ts`, and a second `setMyCommands` call in `bot.test.ts`. The log discloses all
>   of them, and none changes a personal-ledger assertion.
> - Phase 2's service author check came from existing code (`createdBy` checks in
>   `editExpense.ts:52` and `changeCategory.ts:96`). `answerEditFlow` goes back through `openEdit`,
>   so the write path is guarded too, not only the flow start.
> - No ADR was silently reversed. ADR-0014 (separate group composer, binding gate, author-only
>   edits, closed DM allowlist) and ADR-0015 (`ledger.timezone ?? user.timezone` for `occurred_on`
>   at record time and for report periods) hold on the record and report paths. The minor finding
>   below is the edit path, which ADR-0015 doesn't name explicitly.
>
> ## Layering and correctness
>
> - grammY is imported only under `src/bot/`. `groupChats`, `periodSummary` and `todaySummary`
>   take a numeric chat id and never take a Telegram type. `ledger_chats` keys on
>   `(provider, chat_id)` text, and the ledger id is a UUID.
> - All copy lives in `messages.ts`, and user text (first names, ledger names) goes through the
>   `html` template (escaping asserted for `<b>Ира</b>`).
> - No float money and no `new Date()` in domain code. Sums go through `sumByCurrency` / `safeSum`.
> - Idempotency: redelivery records once (source key `tg:<chat>:<msg>`) and doesn't re-confirm. A
>   repeated `my_chat_member` writes nothing and sends no second welcome. Card taps are guarded by
>   soft-delete state.
> - Privacy: the logs carry ids only, never titles or names. Group reports read only the bound
>   ledger, via the binder's membership.
> - Telegram limits: `grp:del|res:<uuid>` is 44 bytes, asserted through `assertCallbackData`. The
>   `e_` and `gs_` payloads are 38 and 39 bytes, asserted.
>
> ## Findings
>
> ### blocker
>
> None.
>
> ### major
>
> None.
>
> ### minor
>
> 1. **The DM card and the date edit for a group expense use the viewer's timezone, not the
>    ledger's.**
>    - **Where:** `src/bot/handlers/card.ts:47` (`sentOn` from `resolveUserTimezone`), and
>      `src/services/editExpense.ts:70`, `:116` and `:194` (`today` for the date prompt, the typed
>      date and the quick buttons).
>    - **Why it matters:** Phase 2 routes every group edit through the author's DM card
>      (`/start e_<id>`). ADR-0015 makes `ledger.timezone ?? user.timezone` the effective zone of
>      an expense, and these paths are the case where the two differ, which nothing probes.
>      Scenario: SECOND_ALLOWED_ID (America/New_York) records `500 такси` in the Belgrade group at
>      `2026-09-30T23:30:00Z`, so `occurred_on` is `2026-10-01`. Opened from the deep link, the DM
>      card computes `sentOn = 2026-09-30` and labels the expense «за 1 октября». The date editor
>      offers New York's 30 September as «сегодня», so one tap moves the expense into September in
>      the group's books. Typing `01.10` is refused as a future date, although the ledger's today
>      is 1 October.
>    - **Suggested fix:** compute `today` and `sentOn` with `effectiveTimezone(deps, user, ledger)`
>      (exported from `src/services/recordExpense.ts`). `openEdit` already returns the ledger, and
>      `cardView` receives it. Add a test in `group.test.ts` with the New York member above,
>      asserting that the card shows no «за …» suffix and that the quick-button `today` is
>      `2026-10-01`. This can be a followup plan: the plan didn't name the edit paths, and the
>      exposure is a member in a different zone near midnight.
>
> ### nit
>
> 1. **The per-person section isn't budgeted against the 4096-character limit.**
>    - **Where:** `src/bot/messages.ts`, `periodSummary`: the totals-only fallback still appends
>      `peopleSection(people)` in full.
>    - **Why it matters:** a group with very many members could still exceed Telegram's message
>      limit after the fallback. At family scale this doesn't happen.
>    - **Suggested fix:** none now. Revisit if groups grow.
>
> ## Bookkeeping owed at close
>
> - Copy the two followups that `dev` logged in Notes into the plan's empty `## Followups`:
>   - In a group, an ambiguous (`1.200 обед`), invalid or future-dated text records nothing and
>     gets no reply.
>   - After a supergroup migration, `/card` replied to an earlier message finds nothing, because
>     the source key carries the old chat id.
>   - Add minor 1 above.
> - Accept ADR-0014 and ADR-0015 (`proposed` to `accepted`), and refresh `docs/adrs/README.md`.
> - Bump the version as a feature plan: minor, 0.6.0 to 0.7.0. Update `package.json`, add a
>   `CHANGELOG.md` entry and the `versionAnnouncements` entry in `src/bot/messages.ts` (ADR-0013).
> - Phase 5 (`human`, `Blocks merge: no`) stays owed: the BotFather `/setjoingroups` and
>   `/setprivacy` settings, then the live check in the family group. Record it in the close
>   section, so the plan doesn't read as fully verified live.
> - Flip the plan's status to `done`, move it to `docs/plans/done/`, repair its links (`../adrs/`
>   to `../../adrs/`, plus inbound links), run `node scripts/check-doc-links.mjs`, and refresh
>   `docs/plans/README.md`.

## Followups

- In a group, an ambiguous (`1.200 обед`), invalid or future-dated text records nothing and gets
  no reply.
- After a supergroup migration, `/card` replied to an earlier message finds nothing, because the
  source key carries the old chat id.
- The DM card and the date editor for a group expense compute "today" in the viewer's timezone,
  not the ledger's (`src/bot/handlers/card.ts`, `src/services/editExpense.ts`): use
  `effectiveTimezone` and test with a New York member in the Belgrade group near midnight.
