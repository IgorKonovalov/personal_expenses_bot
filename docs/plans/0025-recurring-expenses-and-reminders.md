# 0025: Recurring expenses and reminders: rent and subscriptions recorded on their day

> **Status:** in-progress
> **Created:** 2026-10-01
> **Depends on:** [Plan 0019](done/0019-encrypted-personal-ledger.md) (sealed rules in Phase 6)
> **Related ADRs:** [ADR-0031](../adrs/0031-local-time-scheduler.md) (the scheduler),
> [ADR-0015](../adrs/0015-shared-ledgers-carry-a-timezone.md) (ledger time),
> [ADR-0014](../adrs/0014-group-chats-bind-to-shared-ledgers.md) (groups),
> [ADR-0020](../adrs/0020-sealed-ledgers-write-open-read-locked.md) (sealed ledgers),
> [ADR-0035](../adrs/0035-recurring-occurrences-sealed-under-their-rule.md) (sealed occurrences)

## TL;DR

Under an expense's card, [Повторять] offers schedules derived from the expense's date: «Каждый
месяц, 15-го», «Каждую неделю, по средам», «Каждый год, 15.10». On each due day, at 09:00 in the
ledger's timezone, the bot records the expense and posts its card with [Удалить]. A rule can
instead ask first, with [Записать] / [Другая сумма] / [Пропустить], for bills that vary.
`/recurring` lists the rules: switch the mode, delete one, or add a reminder that just sends a
text on its day. Group expenses repeat into their group. After downtime, missed expenses are
recorded on their own dates, once. The first thing the user sees: record `45000 аренда`, tap
[Повторять], then «Каждый месяц, 1-го», and on the 1st at 09:00 «Записано: 45 000.00 RSD —
аренда (регулярная)» appears.

## Context & problem

Fixed monthly costs are the expenses users most often forget to record, and a budget (Plan 0011)
that misses rent is wrong for the whole period. Market check (2026-10-01): Mobs offers scheduled
payments and reminders. The bot has background workers, but nothing that fires per user at a
local time. ADR-0031 introduces that scheduler, and Plan 0026 reuses it.

## Decision

Rules are rows in `recurring_rules`, each holding a template (amount, currency, description,
category), a schedule (`monthly` on a day of the month, `weekly` on a weekday, `yearly` on a
day and month), a mode (`auto` or `ask`) and `next_due_on`, a local date. The ADR-0031 scheduler
fires a rule when now passes 09:00 on `next_due_on` in the ledger's effective timezone. Firing
inserts `(rule_id, due_on)` into `recurring_occurrences`. In `auto` mode it also records the
expense, with source key `rec:<rule>:<due_on>`, and advances `next_due_on`, all in one transaction.
Messages go out after the commit.

Monthly rules for days 29–31 fall on the month's last day in shorter months. The stored day never
changes, so a rule for the 31st returns to the 31st. A yearly 29 February falls on 28 February in
common years.

We rejected a typed command grammar for creating rules (one more grammar to learn), and a per-rule
firing time (fixed 09:00, ADR-0031).

## Architecture diagram

```mermaid
sequenceDiagram
    participant W as scheduler tick (60 s)
    participant P as recurring provider
    participant DB as db
    participant B as bot api
    W->>P: due(now)
    P->>DB: rules with 09:00 on next_due_on (ledger tz) <= now
    loop each due occurrence (at most 31 per rule)
      P->>DB: BEGIN; insert occurrence (rule, due_on); record expense (auto); advance next_due_on; COMMIT
      P->>B: card with [Удалить] (auto) or [Записать]/[Другая сумма]/[Пропустить] (ask)
    end
```

## Implementation phases

Each phase ships as its own commit. `dev` implements all phases in one session with no review
between phases. The architect reviews once at the end, in a fresh session. All new copy goes in
`src/bot/messages.ts`, in Russian. Every test drives time through the injected clock, so no test
sleeps.

### Phase 1: Walking skeleton: monthly rent recorded on the 1st
- **Owner skill:** dev
- **What:**
  - `src/scheduler/` holds the ADR-0031 worker: a tick at boot, then every 60 seconds, an
    in-flight guard, registered providers, and a stop for shutdown. `src/index.ts` starts it.
  - The next free migration adds `recurring_rules` and `recurring_occurrences` (Data shapes).
  - The private expense card gains [Повторять] (`rec:new:<uuid>`, 44 bytes) for the expense's
    author. In this phase it offers one option, «Каждый месяц, <D>-го», with D taken from the
    expense's `occurred_on` (`rec:s:<uuid>:m`, 44 bytes).
  - Choosing it creates an `auto` rule from the expense's amount, currency, description and
    category, with `next_due_on` the next date after today on that schedule. The card is edited
    to say the rule exists (`recurringCreated`).
  - The recurring provider records due occurrences as described in the Decision and posts
    `recurringRecorded`, the usual confirmation marked «(регулярная)», with the usual undo
    keyboard, to the author's private chat.
  - `/recurring` lists the user's rules: description, money, schedule in words, and next date.
    `/recurring` joins `messages.commands`.
- **Files touched:** `src/scheduler/worker.ts` (+ test), `src/scheduler/types.ts`,
  `src/domain/schedule.ts` (+ test), `src/db/migrations/00NN_recurring.sql`,
  `src/db/recurring.ts` (+ test), `src/services/recurring.ts` (+ test),
  `src/bot/recurringProvider.ts` (+ test), `src/bot/handlers/card.ts`,
  `src/bot/handlers/recurring.ts`, `src/bot/callbackData.ts`, `src/bot/callbacks.ts`,
  `src/bot/messages.ts`, `src/bot/bot.ts`, `src/index.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - A rule made on `2026-10-02` from an expense dated `2026-10-01` has `next_due_on` = `2026-11-01`.
  - For a `Europe/Belgrade` user, a tick at `2026-11-01T07:59:00Z` (08:59 CET) records nothing. A
    tick at `2026-11-01T08:00:00Z` (09:00 CET) records 4500000 minor units RSD «аренда», dated
    `2026-11-01`, and sets `next_due_on` to `2026-12-01`.
  - Two ticks running the same occurrence (simulated by calling the provider twice with the same
    now) record one expense.
  - The posted confirmation's [Удалить] soft-deletes that expense, and the rule keeps its next
    date.
  - `/today` on `2026-11-01` includes the recorded rent.

### Phase 2: Weekly and yearly, short months, DST and catch-up
- **Owner skill:** dev
- **What:**
  - [Повторять] offers three options from the expense's date: monthly on its day, weekly on its
    weekday, and yearly on its day and month (`rec:s:<uuid>:w|y`). The labels are
    `recurringMonthly(D)`, `recurringWeekly(weekday)` (by-day form: «по средам») and
    `recurringYearly(DD.MM)`.
  - `nextOccurrence(schedule, after)` in `src/domain/schedule.ts` is pure. It handles the
    month-end clamp and 29 February.
  - Catch-up: on a tick, an `auto` rule records every missed occurrence up to today, each dated
    its own `due_on`, up to 31 per rule per tick. Any remainder follows on the next tick.
- **Files touched:** `src/domain/schedule.ts` (+ test), `src/services/recurring.ts` (+ test),
  `src/bot/handlers/card.ts`, `src/bot/callbackData.ts`, `src/bot/messages.ts`,
  `src/bot/bot.test.ts`.
- **Done when:**
  - A monthly rule for day 31 created from `2026-01-31` falls on `2026-02-28`, then `2026-03-31`,
    then `2026-04-30`.
  - A yearly rule from `2024-02-29` falls on `2025-02-28`, `2026-02-28`, `2027-02-28`, then
    `2028-02-29`.
  - A weekly rule from Wednesday `2026-10-07` falls on `2026-10-14`, then `2026-10-21`.
  - In `Europe/Belgrade`, a weekly Saturday rule's occurrence on `2026-10-24` fires at `07:00Z` (09:00 CEST), and the
    one on `2026-10-31` fires at `08:00Z` (09:00 CET, after the 25 October change).
  - With the bot down from `2026-10-31` to a tick at `2026-12-02T10:00:00Z`, a monthly rule for
    the 1st records two expenses, dated `2026-11-01` and `2026-12-01`, and its `next_due_on` is
    `2027-01-01`.
  - A user who changes timezone from Belgrade to `Asia/Almaty` (UTC+5) before the next occurrence
    gets it at `04:00Z` on its date.

### Phase 3: Ask mode and managing rules
- **Owner skill:** dev
- **What:**
  - `/recurring` shows each rule as a button (`rec:r:<uuid>`, 42 bytes) opening its screen. The
    screen has the rule's details and the next date, plus:
    - [Спрашивать перед записью] or [Записывать само], to toggle the mode;
    - [Удалить правило] (a confirm step, per the house rule for irreversible actions);
    - [« Назад].
  - An `ask` occurrence claims `(rule, due_on)` and posts `recurringAsk` with these buttons:
    - [Записать <money>] (`rec:ok:<uuid>:<YYYY-MM-DD>`, 54 bytes);
    - [Другая сумма] (`rec:amt:<uuid>:<date>`, 55 bytes), which opens an amount flow (ADR-0009);
    - [Пропустить] (`rec:skip:<uuid>:<date>`, 56 bytes).
    Recording uses source key `rec:<rule>:<due_on>`, so a double tap records once. Catch-up in
    ask mode posts one prompt per missed occurrence, up to 3, plus a line naming how many more
    were skipped.
  - Deleting a rule sets `deleted_at`. Expenses already recorded stay.
- **Files touched:** `src/db/recurring.ts` (+ test), `src/services/recurring.ts` (+ test),
  `src/bot/recurringProvider.ts` (+ test), `src/bot/handlers/recurring.ts`, `src/bot/flows.ts`,
  `src/services/flowSessions.ts`, `src/bot/callbackData.ts`, `src/bot/messages.ts`,
  `src/bot/bot.test.ts`.
- **Done when:**
  - An ask-mode rule's due tick records nothing and posts the prompt. [Записать] records the
    template amount on the due date, and a second tap records nothing more.
  - [Другая сумма] then `4870` records 487000 minor units in the rule's currency.
  - [Пропустить] records nothing, and the prompt is edited to «Пропущено».
  - Every callback above stays within 64 bytes (asserted).
  - A deleted rule never fires again, and its past expenses remain in `/month`.

### Phase 4: Reminders
- **Owner skill:** dev
- **What:**
  - `/recurring` gains [Добавить напоминание]. It asks for the text (1–200 characters), then the
    schedule from today's date: «Каждый месяц, <D>-го», «Каждую неделю, по <день>»,
    «Каждый год, <DD.MM>». Reminders are personal and private.
  - On the day the bot sends `reminderDue(text)` to the private chat, with [Записать трату]
    (`rec:rx`, an expense-entry hint).
  - Catch-up sends only the latest missed reminder (ADR-0031).
- **Files touched:** `src/db/recurring.ts` (+ test), `src/services/recurring.ts` (+ test),
  `src/bot/recurringProvider.ts` (+ test), `src/bot/handlers/recurring.ts`, `src/bot/flows.ts`,
  `src/bot/callbackData.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - A monthly reminder «заплатить за интернет» made on `2026-10-02` fires on `2026-11-02` at 09:00
    local, with the text escaped.
  - After three missed months, one reminder is sent, and `next_due_on` lands in the future.
  - A reminder creates no expense.

### Phase 5: Group ledgers
- **Owner skill:** dev
- **What:**
  - The author's private card for a group expense (opened by [Изменить в личке]) offers
    [Повторять]. The rule belongs to the group ledger and to the author.
  - An `auto` occurrence records the expense as the author's, in the group ledger, and posts the
    group card with [Удалить] (author only, ADR-0014) into the bound chat. An `ask` prompt goes
    to the group, and only the author can tap it. Others get `groupNotAuthor`.
  - If the ledger has no active chat binding, the occurrence is recorded (in `auto` mode) and the
    notice goes to the author's private chat instead. If the author is no longer a member, the
    rule is paused (`paused_at`) and nothing fires.
- **Files touched:** `src/services/recurring.ts` (+ test), `src/bot/recurringProvider.ts`
  (+ test), `src/bot/handlers/card.ts`, `src/bot/group/card.ts`, `src/bot/messages.ts`,
  `src/bot/group/group.test.ts`.
- **Done when:**
  - A group rule fires once into the bound chat, with the group's timezone deciding 09:00.
  - A non-author's tap on its [Записать] records nothing.
  - With the chat unbound, the expense is recorded, and the notice reaches the author's private
    chat.

### Phase 6: Sealed ledgers, help and docs
- **Owner skill:** dev
- **What:**
  - In a sealed personal ledger (Plan 0019), a rule's template is stored as a sealed payload
    created when the rule is made, while the ledger is unlocked to read the source expense. It is
    sealed with the associated data `<ledgerId>:rule:<ruleId>` (ADR-0035). Each `auto` occurrence
    writes a new expense row carrying a byte copy of that payload, with the next free migration's
    nullable `expenses.sealed_rule_id` naming the rule, so the scheduler never needs the
    passphrase.
  - `rowAad` becomes a function of the row: the rule binding when `sealed_rule_id` is set, the
    expense id otherwise, at every open site (`openRow`, `foldedReceipt`, `resealed`). Editing an
    occurrence reseals it under its own expense id and clears `sealed_rule_id`.
  - Enabling encryption on a ledger with expense rules seals their templates and clears their
    plaintext columns in the same transaction as its rows.
  - The posted notice is `recurringRecordedSealed`, which has no amount or description and keeps
    [Удалить]. Ask mode in a sealed ledger posts `recurringAskSealed`, which has no amount, offers
    [Записать] and [Пропустить], and drops [Другая сумма].
  - Reminder texts aren't ledger data, and they stay plaintext. The text prompt says so when the
    personal ledger is sealed.
  - `/help` gains a recurring paragraph, and the README lists `/recurring`.
- **Files touched:** `src/domain/sealing.ts` (+ test), `src/db/migrations/` (the next free
  migration: `expenses.sealed_rule_id`), `src/db/expenses.ts` (+ test), `src/db/recurring.ts`
  (+ test), `src/services/ledgerKeys.ts` (+ test), `src/services/sealLedger.ts` (+ test),
  `src/services/recurring.ts` (+ test), `src/bot/recurringProvider.ts`, `src/bot/messages.ts`,
  `src/bot/bot.test.ts`, `README.md`.
- **Done when:**
  - A sealed-ledger rule's row holds no plaintext amount or description.
  - Its occurrence records an expense that decrypts after `/unlock` to the template's amount and
    description, on the due date, with the ledger locked when the occurrence fires.
  - Editing that occurrence's amount after `/unlock` leaves a row that still decrypts, with
    `sealed_rule_id` NULL.
  - The rule's template copied onto a row without `sealed_rule_id` fails to open.
  - Enabling encryption on a ledger that already has an expense rule leaves that rule's row
    with no plaintext amount or description, and its next occurrence decrypts.
  - The sealed notice contains neither the amount nor the description.

### Phase 7: A real month
- **Owner skill:** human
- **Blocks merge:** no
- **What:** On the deployed bot, make a monthly rule for a real bill in `ask` mode, a weekly
  `auto` rule and a reminder. Restart the bot across one due time.
- **Done when:** Each fires once at 09:00 local, including the one due during the restart, and
  `/recurring` shows the next dates correctly.

## Data shapes

```sql
-- illustrative
CREATE TABLE recurring_rules (
  id TEXT PRIMARY KEY,
  ledger_id TEXT REFERENCES ledgers(id),          -- NULL for a reminder
  user_id TEXT NOT NULL REFERENCES users(id),     -- the author
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'ask')),
  amount_minor INTEGER, currency TEXT, description TEXT, category_id INTEGER,  -- NULL when sealed
  sealed BLOB,                                    -- the sealed template (Phase 6)
  reminder_text TEXT,
  schedule TEXT NOT NULL CHECK (schedule IN ('monthly', 'weekly', 'yearly')),
  day INTEGER,      -- 1-31 for monthly and yearly
  weekday INTEGER,  -- 1-7 (ISO) for weekly
  month INTEGER,    -- 1-12 for yearly
  next_due_on TEXT NOT NULL,                      -- local date
  paused_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX recurring_due ON recurring_rules(next_due_on) WHERE deleted_at IS NULL AND paused_at IS NULL;
CREATE TABLE recurring_occurrences (
  rule_id TEXT NOT NULL REFERENCES recurring_rules(id),
  due_on TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('recorded', 'asked', 'reminded', 'skipped')),
  expense_id TEXT REFERENCES expenses(id),
  PRIMARY KEY (rule_id, due_on)
);
```

Callback data: `rec:new:<uuid>` (44), `rec:s:<uuid>:<m|w|y>` (44), `rec:r:<uuid>` (42),
`rec:ok:<uuid>:<date>` (54), `rec:amt:<uuid>:<date>` (55), `rec:skip:<uuid>:<date>` (56), `rec:rx`.

## Risks & open questions

- **Idempotency.** The occurrence key and the expense's source key `rec:<rule>:<due_on>` both
  make an occurrence happen once, through restarts, overlapping ticks and double taps.
- **Time.** `next_due_on` is a local date, and the 09:00 instant is computed per tick in the
  ledger's current timezone. Phase 2 tests the DST change and a timezone change.
- **Money.** A template is an integer amount and an ISO currency, copied unchanged.
  `ask` mode's [Другая сумма] uses the amount parser.
- **Privacy.** Logs carry rule ids and outcomes, never amounts, descriptions or reminder texts.
  Reminder text is stored plaintext, even for a sealed ledger's owner, and the prompt says so.
- **A notice lost to a send failure** isn't retried (ADR-0031). An auto-recorded expense still
  shows in `/today`.
- **Budgets** count a recurring expense only once it's recorded, not in advance.
- **Plan 0029's `/delete_account`** must also delete the user's rules and occurrences. Whichever
  plan lands second adds that.

## What this plan does NOT do

- Income or salary as a recurring entry (the bot has no income).
- Detecting recurring spending automatically from history.
- A per-rule firing time, or schedules beyond monthly, weekly and yearly (every N days, the last
  weekday of the month).
- Forecasting upcoming recurring spend in the budget.
- The monthly summary push (Plan 0026, the scheduler's next provider).

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: monthly rent recorded on the 1st | dev | done | committed with this row |
| 2: Weekly and yearly, short months, DST and catch-up | dev | not started | |
| 3: Ask mode and managing rules | dev | not started | |
| 4: Reminders | dev | not started | |
| 5: Group ledgers | dev | not started | |
| 6: Sealed ledgers, help and docs | dev | not started | |
| 7: A real month | human | not started | |

### Notes

- Phase 1: `src/bot/render/html.ts` (not in Files touched) gained an optional `extra` on
  `sendHtml`, so the provider can send a notice with a keyboard; the lint gate forbids
  `sendMessage` outside `render/`.
- Phase 1: the migration adds `recurring_rules.source_key` (`exp:<expenseId>:<m|w|y>`, a partial
  unique index over live rules), not in Data shapes, so a double tap on a schedule makes one rule.
- Phase 1: [Повторять] is offered only on a personal, unsealed ledger's card until Phases 5 and 6.
- Phase 1: `nextOccurrence` already clamps a monthly day to the month's last day.
- Phase 1: `src/bot/callbacks.ts` needed no change.

### Close triggers

## Followups
