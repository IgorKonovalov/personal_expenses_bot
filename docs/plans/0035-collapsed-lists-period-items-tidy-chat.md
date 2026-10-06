# 0035: Collapsed lists, receipt items by category for a day, week or month, and an opt-in tidy chat

> **Status:** in-progress (2026-10-06)
> **Created:** 2026-10-06
> **Related ADRs:** [ADR-0038](../adrs/0038-collapse-with-expandable-quotes-opt-in-tidy-chat.md)
> (collapse and tidy chat), [ADR-0011](../adrs/0011-navigation-model.md) (cards and the screen
> anchor), [ADR-0018](../adrs/0018-receipts-record-offline-enrich-async.md) (receipts),
> [ADR-0020](../adrs/0020-sealed-ledgers-write-open-read-locked.md) (sealed ledgers)

## TL;DR

Long lists stop cluttering the chat. A fetched receipt's card shows its items in Telegram's
expandable quote, which starts collapsed: one tap opens it and another closes it, with nothing
sent to the bot. `/week` and `/month` collapse their category lines the same way. `/today`,
`/week` and `/month` gain a [Позиции] button that lists the period's receipt items grouped by
category, each category collapsed under a line with its total and item count. Inside a category,
items are sorted by name, so every «Хлеб» sits together, which is the first step toward
comparing prices over time. A new `/settings` switch, off by default, deletes the user's own
message once it has recorded an expense. The first change the user sees: a new receipt card
arrives with its items folded under it.

## Context & problem

The user reads a receipt's items by tapping [Позиции], which edits the card into a list that can
run to several pages. When they scroll back up, the list is still open, and with the summaries
and the user's own messages around it the chat looks cluttered. The user wants to hide what they
don't need right now.

Separately, the user wants to see what they bought in a period, not only how much each category
cost. Seeing the same product's lines next to each other is the base for later price
comparisons (inflation). Receipt items today are reachable only one receipt at a time, through
its card, or in bulk through `/export`.

Facts from the tree that shape the plan:

- `receipt_items` has `name`, `quantity` (a decimal string) and `total_minor` in the expense's
  currency. Items carry no category, so the expense's category is their category.
- A sealed ledger keeps a receipt's items inside the expense's sealed payload
  (`foldedReceipt`), not in `receipt_items` (ADR-0020). `receiptItems` in
  `src/services/fetchDueReceipt.ts` already reads both paths, and only the expense's author may
  see its items.
- `/week` and `/month` are screens on the user's anchor (`src/bot/handlers/summary.ts`).
  `/today` is a plain reply with no keyboard (`src/bot/handlers/today.ts`).
- Receipt photos are already deleted once recorded (Plan 0034, `deleteReceiptPhoto` in
  `src/bot/handlers/receipt.ts`).

## Decision

Collapse long lists with `<blockquote expandable>` and add no buttons for it. Add the period
items view as a state of the existing summaries, reached by [Позиции], not as a new command.
Group items by their expense's category: product matching (folding `MLEKO 2.8% 1L` and
`Mleko Imlek` into one product) is a later plan. Deleting the user's messages is an opt-in
setting. The reasons and the rejected alternatives are in ADR-0038. We rejected a separate
`/items` command with its own period picker because the summaries already know the period and
the ledger. We rejected normalized product names for now because rule-based matching across
shops is a project of its own, and grouping by name sort already puts identical names together.

## Architecture diagram

```mermaid
flowchart LR
    subgraph Telegram
      T[tap Позиции on /today, /week, /month]
    end
    subgraph bot[bot adapter]
      H[handlers/items.ts] --> M[messages.periodItemPages]
    end
    subgraph services
      S[periodItems.ts]
    end
    subgraph domain
      G[receipts/itemGroups.ts: group, sort, total]
    end
    subgraph db
      E[expenses + openExpenses]
      I[receipt_items / folded payload]
    end
    T --> H --> S
    S --> E
    S --> I
    S --> G
    H -- edit in place, pager, back --> T
```

## Implementation phases

### Phase 1: a receipt card shows its items collapsed
- **Owner skill:** dev
- **What:** In a private chat, a fetched receipt's card shows the author its items inside
  `<blockquote expandable>`, below the receipt line, in the format `receiptItemLine` already
  uses. When the card with its items would exceed `MAX_VISIBLE_CHARS`, the card stays as it is
  today: no quote, and the [Позиции] pager. With the quote shown, the card drops the [Позиции]
  button. Group cards (`src/bot/group/card.ts`), a card for an expense the viewer didn't record,
  and a sealed ledger's card while it is locked stay as today.
- **Files touched:** `src/bot/handlers/card.ts`, `src/bot/messages.ts`,
  `src/bot/receiptWorker.ts` (the card edited after a fetch), `src/bot/messages.test.ts`,
  `src/bot/bot.test.ts` or the card's existing test file.
- **Done when:**
  - A fetched receipt with the items `Хлеб` (quantity `0.535`, 7999 minor RSD) and `Молоко`
    (quantity `1`, 14900) renders a card whose HTML contains `<blockquote expandable>` holding
    `1. Хлеб × 0.535 — 79.99 RSD` and `2. Молоко — 149.00 RSD`, with no [Позиции] button.
  - A fetched receipt whose card with items exceeds `MAX_VISIBLE_CHARS` (a fixture with enough
    long-named items) renders no blockquote and keeps [Позиции].
  - The receipt worker's edit after a successful fetch sends the collapsed-items card.
  - A shop name or item name containing `<b>` reaches the message escaped (`&lt;b&gt;`).

### Phase 2: /week and /month fold their category lines
- **Owner skill:** dev
- **What:** In `messages.periodSummary`, each currency block keeps its bold total on its own line
  and wraps its category lines in `<blockquote expandable>`. The order is unchanged (by amount).
  The "too many categories" fallback is unchanged.
- **Files touched:** `src/bot/messages.ts`, `src/bot/messages.test.ts`.
- **Done when:** A summary with categories Еда 61398, Дом 39900 and Транспорт 12000 minor RSD
  renders the bold total `1 132.98 RSD`, then a single `<blockquote expandable>` holding the
  three category lines in that order. (61398 + 39900 + 12000 = 113298 minor units. Write the
  expected total with whatever thousands separator `formatMoney` produces, taken from the
  existing summary tests, not from this plan.) A summary with no expenses renders exactly as
  before.

### Phase 3: [Позиции] on /week and /month lists the period's items by category
- **Owner skill:** dev
- **What:** The summary screen gains a [Позиции] button in a private chat. It edits the anchor
  into the period items view: a header with the period and ledger. Under it, each category gets
  a bold line with its name, its items' total per currency and its item count, and then
  `<blockquote expandable>` with its items as `DD.MM Name × qty — amount`. The quantity part
  appears only when the quantity isn't 1, matching `receiptItemLine`. A last line counts the
  period's expenses that have no fetched receipt (`Трат без чека: N`), omitted when N is 0.
  Rules:
  - Only expenses the viewer recorded, not deleted, with `occurred_on` inside the period, and a
    fetched receipt. In a shared ledger the header says the list holds only the viewer's
    receipts.
  - Categories are ordered by their total in the ledger's default currency, descending. A
    category with none of that currency comes after, by name. «Без категории» is a category.
  - Items inside a category are sorted by name, case-insensitively with a Russian `Intl.Collator`,
    then by date, then by receipt and position.
  - A category's total is the integer sum of its items' `total_minor` per currency, never
    converted. With two currencies it shows both, joined with ` + `.
  - Pages are cut on whole lines within `MAX_VISIBLE_CHARS`. A category cut across pages repeats
    its bold line with `(продолжение)` on the next page. The pager and [← Назад] sit under it.
    [← Назад] restores that period's summary in the anchor.
  - A locked sealed ledger answers with the `ledgerLockedToast` toast and edits nothing. A
    sealed ledger that is unlocked reads items from the folded payload, as `receiptItems` does.
  Grouping, sorting and totals are a pure domain function. The service reads the expenses the
  way `ledgerPeriodSummary` does, then the items, plaintext from `receipt_items` and sealed ones
  from `foldedReceipt`.
- **Files touched:** `src/domain/receipts/itemGroups.ts`, `src/domain/receipts/itemGroups.test.ts`,
  `src/db/receiptItems.ts` (items for a list of expense ids), `src/db/receiptItems.test.ts`,
  `src/services/periodItems.ts`, `src/services/periodItems.test.ts`, `src/bot/handlers/items.ts`,
  `src/bot/handlers/summary.ts`, `src/bot/callbackData.ts`, `src/bot/messages.ts`,
  `src/bot/messages.test.ts`, `src/bot/bot.ts`, `src/bot/bot.test.ts`.
- **Done when:** With the fixture below (the user is in `Europe/Belgrade`, `now` is
  2026-10-06T10:00:00Z, a Tuesday, and the week runs Monday 2026-10-05 to Sunday 2026-10-11),
  every expense recorded through `recordExpense` and receipt so that `occurred_on` is computed,
  not hand-set:

  | Receipt | Instant (UTC) | Local day | Category | Items (minor RSD) |
  |---|---|---|---|---|
  | A | 2026-10-05T09:00Z | 05.10 | Еда | Хлеб 7999, Молоко 14900 |
  | B | 2026-10-06T08:00Z | 06.10 | Еда | Хлеб 8499 |
  | C | 2026-10-06T09:00Z | 06.10 | Дом | Средство 39900 |
  | D | 2026-10-04T09:00Z | 04.10 (previous week) | Еда | Хлеб 7599 |
  | E | 2026-10-06T09:30Z, then deleted | 06.10 | Еда | Сыр 50000 |
  | F | 2026-10-06T22:30Z | 07.10 (00:30 CEST) | Еда | Кофе 30000 |

  - `itemGroups` for the week returns Еда first with 61398 (7999 + 14900 + 8499 + 30000) and 4
    items in the order Кофе 07.10, Молоко 05.10, Хлеб 05.10, Хлеб 06.10, then Дом with 39900
    and 1 item.
  - The month view for October 2026 has Еда at 68997 (61398 + 7599) with 5 items, and Дом at
    39900. Сыр (deleted E) appears in no view.
  - A receipt recorded by another member of a shared ledger in the same week appears in no
    view of this user.
  - A plaintext expense with no receipt on 06.10 makes the week view end with `Трат без чека: 1`.
  - Through the bot harness, tapping [Позиции] on the week screen edits the anchor into a page
    whose HTML holds `<b>Еда</b>`, a `<blockquote expandable>` and the four Еда lines.
    [← Назад] restores the week summary.
  - A fixture with enough items to need two pages splits on a whole line. The second page
    starts with the cut category's line marked `(продолжение)`, and no page's
    `visibleLength` exceeds 4096.
  - The callback data for the longest key (`itm:d:2026-10-06:` plus a two-digit page) is at
    most 64 bytes, checked by `assertCallbackData`.

### Phase 4: [Позиции] on /today
- **Owner skill:** dev
- **What:** The `/today` reply in a private chat gains a [Позиции] button for that local day,
  acting on the user's active ledger at tap time. The view is the Phase 3 view for one day,
  without the `DD.MM` prefix. [← Назад] edits the message back into `/today` for the current
  day. The button is omitted when the day has no receipt items.
- **Files touched:** `src/bot/handlers/today.ts`, `src/bot/handlers/items.ts`,
  `src/bot/callbackData.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`.
- **Done when:** With the Phase 3 fixture, `/today` on 2026-10-06 shows [Позиции]. Tapping it
  shows Дом (39900, Средство) above Еда (8499, Хлеб), with no Кофе (that's 07.10) and no Сыр.
  A day with expenses but no receipts shows no [Позиции].

### Phase 5: an opt-in tidy chat deletes the user's recorded messages
- **Owner skill:** dev
- **What:** A `users.tidy_chat` flag, off by default, toggled from a `/settings` row. When it is
  on, in a private chat, once a message has recorded an expense (recorded or duplicate), the bot
  sends the card and then deletes the user's message. That covers a typed expense, a receipt
  link and a bank SMS. An ambiguous amount deletes the original only once a reading is chosen
  and recorded. A message that recorded nothing (invalid, future date, not an expense, a flow
  answer) is never deleted. A failed delete is logged at warn with the update id and the error
  name only. Generalize `deleteReceiptPhoto` into one helper for both. Ask `ux-telegram` for the
  row's label and the switch's states before wiring the copy, or use `Убирать мои сообщения:
  вкл/выкл` if the user skips that.
- **Files touched:** `src/db/migrations/0023_tidy_chat.sql`, `src/db/users.ts`,
  `src/db/users.test.ts`, `src/services/settings.ts`, `src/services/settings.test.ts`,
  `src/bot/handlers/settings.ts`, `src/bot/handlers/text.ts`, `src/bot/handlers/ambiguous.ts`,
  `src/bot/handlers/receipt.ts`, `src/bot/callbackData.ts`, `src/bot/messages.ts`,
  `src/bot/bot.test.ts`.
- **Done when:**
  - With `tidy_chat` on, a private `450 кофе` records 45000 minor units and the harness sees
    `deleteMessage` for that message's id after the card's `sendMessage`. With it off, there is no
    `deleteMessage`.
  - With it on, `привет` (not an expense) and an invalid amount trigger no `deleteMessage`.
  - With it on, the same expense text sent in a group triggers no `deleteMessage`.
  - With it on, an ambiguous amount triggers no `deleteMessage` until a reading is tapped, then
    one for the original message.
  - A `deleteMessage` that rejects leaves the expense recorded and the card sent, and the warn log
    holds no amount or description.
  - The migration leaves existing users at `tidy_chat = 0`.

### Phase 6: live check on a phone and the desktop
- **Owner skill:** human
- **Blocks merge:** no
- **What:** On the deployed bot, scan a real receipt and check that the card arrives with its
  items collapsed and opens and closes with a tap, on mobile and on Telegram Desktop. Open
  `/week` and check the folded categories. Tap [Позиции] and page through and back. Turn on the
  tidy switch, send an expense and see the message disappear.
- **Files touched:** none.
- **Done when:** The user confirms each of the four checks on at least one mobile client and on
  Desktop, or names what failed.

## Data shapes

```ts
// illustrative
// src/domain/receipts/itemGroups.ts
interface PeriodItem {
  name: string;
  quantity: string;        // decimal string, as stored
  totalMinor: number;      // integer, in `currency`
  currency: CurrencyCode;
  occurredOn: LocalDate;
  categoryId: number | null;
  receiptKey: string;      // a stable order for ties: receipt id or expense id
  position: number;
}
interface ItemGroup {
  categoryId: number | null;
  totals: Money[];         // one per currency, default currency first
  items: PeriodItem[];     // sorted: name (ru collator), date, receiptKey, position
}
function groupItems(items: readonly PeriodItem[], defaultCurrency: CurrencyCode): ItemGroup[];
```

```sql
-- 0023_tidy_chat.sql (illustrative)
-- 0 | 1: delete the user's private message once it has recorded an expense (ADR-0038).
ALTER TABLE users ADD COLUMN tidy_chat INTEGER NOT NULL DEFAULT 0;
```

Callback data, each checked by `assertCallbackData`: `itm:d:<YYYY-MM-DD>:<page>`,
`itm:w:<Monday YYYY-MM-DD>:<page>`, `itm:m:<YYYY-MM>:<page>` (at most 19 bytes for a two-digit
page), and one key for the tidy switch in the `set:` family.

## Risks & open questions

- **Items total isn't the summary total.** Item lines can omit discounts or rounding that the
  receipt total carries, and expenses without receipts aren't listed. The view says it lists
  items. The `Трат без чека` line keeps it from looking like the whole period.
- **Entity count.** Telegram limits formatting entities per message, and the documented limit
  isn't certain (unverified; 100 is often quoted). Each category adds about two. If a dense page
  is rejected, cut pages by entity count as well as length. Phase 6 should include the user's
  busiest month.
- **Client support.** Clients before Bot API 7.4 show an expandable quote fully expanded, which
  is no worse than today.
- **Time.** Period membership uses the stored local `occurred_on`, never a UTC date. Receipt F
  in the fixture defends that.
- **Privacy.** Item names are shop text. They go through `html` escaping, never reach logs, and
  appear only in fixtures with invented names.
- **Idempotency.** The items view and the switch only read or set a flag, so double taps are
  harmless. A tidy delete repeated on a redelivered update fails harmlessly and is logged at warn
  without content.
- **Today's back button.** A `/today` items view opened yesterday goes back to today's summary,
  not yesterday's. This is accepted to keep `/today` a plain reply rather than a screen.

## What this plan does NOT do

- **No product matching or unit prices.** It doesn't fold `MLEKO 2.8%` and `Mleko Imlek` into one
  product, doesn't compute price per kg or litre, and doesn't track a product's price over months.
  That is a future "price tracking" plan, which can build on `itemGroups`.
- **No per-item categories.** An item takes its expense's category.
- **No currency conversion in the items view.** Totals stay per currency.
- **No items view in group chats**, and no change to group cards.
- **No deletion of the bot's own old messages**, no "clear the chat" button, and no deleting of
  flow answers or `/commands` the user typed (ADR-0038).
- **No re-rendering of messages already in the history.** They pick up the new look only when
  next edited.

## Implementation log

| phase | owner | state | commit |
|---|---|---|---|
| 1: card items collapsed | dev | done | 371a6f9 |
| 2: summary categories folded | dev | done | committed with this row |
| 3: period items on /week, /month | dev | not started | |
| 4: period items on /today | dev | not started | |
| 5: tidy chat | dev | not started | |
| 6: live check | human | not started | |

### Notes

- Phase 1: `src/bot/receiptWorker.ts` needed no change: the worker already renders the card
  through `cardView` for the author, which now carries the items. Its done-when is a harness test
  in `src/bot/bot.test.ts` that runs `startReceiptWorker` against the harness API. No
  `messages.test.ts` case was added; the card's HTML is asserted in `bot.test.ts`.
- Phase 1: the fold check reserves room for the `Уже записано.` line, so a duplicate's card that
  fits without it but not with it keeps [Позиции].
- Phase 2: touched `src/bot/bot.test.ts`, outside the phase's `Files touched`, to update the
  existing /week and /month expectations to the folded form. Group summaries share
  `messages.periodSummary` and fold too; `group.test.ts` derives its expectations from it.

### Close triggers

## Followups
