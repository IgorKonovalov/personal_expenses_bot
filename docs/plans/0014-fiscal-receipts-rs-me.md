# 0014: Fiscal receipts: a QR photo or link from Serbia or Montenegro becomes an expense with its line items

> **Status:** in-progress (2026-10-01)
> **Created:** 2026-10-01
> **Related ADRs:** [ADR-0018](../adrs/0018-receipts-record-offline-enrich-async.md),
> [ADR-0019](../adrs/0019-qr-decoding-zxing-wasm.md),
> [ADR-0004](../adrs/0004-amount-parsing-rule.md) (structured sources are exempt from it),
> [ADR-0011](../adrs/0011-navigation-model.md) (the expense card)

## TL;DR

In DM, the user sends a photo of a Serbian or Montenegrin fiscal receipt, as a photo or as an image
file, or pastes the receipt's verification link. The bot reads the QR at once and records one
expense with the receipt's total, in RSD or EUR, dated the receipt's local day. It answers with
the usual card and [Удалить]. A few seconds later, the card updates itself with the shop name
and a [Позиции] button listing the line items fetched from the tax authority's site (ADR-0018).
Sending the same receipt into the same ledger again gets «уже записано» and the existing card. The
first thing the user sees: they paste a `suf.purs.gov.rs/v/?vl=…` link and get
«Записано в Личное: 829,12 RSD — Чек».

## Context & problem

Receipts are the main way spending arrives in Serbia and Montenegro, and typing totals off long
receipts is the friction the user wants gone. The roadmap has carried "fiscal QR receipts" since
Plan 0001, narrowed to Serbia first in Plan 0009. Nothing has been built: photos fall into
`registerNonText` and get the help reply. The pieces we can reuse:

- `expenses.source_key` was designed for this kind of dedupe (Plan 0001), but it's globally
  `UNIQUE` (see ADR-0018 for the key shape).
- `RSD` and `EUR` are in `src/domain/currencies.ts`, both with exponent 2.
- `suggestCategory` (ADR-0008) and the ADR-0011 card with its edit and category flows.
- ADR-0004 already exempts fiscal QR payloads from the typed-amount parsing rule.

Researched on 2026-10-01 and recorded in ADR-0018/0019: both QR formats carry the total, the
instant and a fiscal id offline. Line items need one or two requests to an undocumented public
endpoint. Russia (ФНС) and Kazakhstan (several fiscal data operators) are out of scope here.

## Decision

Record the total from the QR offline, in the handler. Enrich with the seller name and items from
an in-process background worker that keeps its queue in a `receipts` table (ADR-0018). Decode
images with `zxing-wasm` loaded from `node_modules` (ADR-0019). Receipts are DM-only in this plan.
The group composer from Plan 0009 keeps ignoring photos.

We rejected fetching inside the handler (sequential polling would stall every user on a slow tax
site), one expense per line item (the user's call: one receipt, one expense), and jsQR or sharp
for decoding (ADR-0019).

## Architecture diagram

```mermaid
flowchart LR
    subgraph Telegram
        P[photo / image file / link text]
    end
    subgraph adapter[bot adapter]
        H[receipt handler] --> Q[fiscal/qr.ts zxing-wasm]
        W[receipt worker timer] --> E[edit card]
    end
    subgraph domain
        D[receipts/rsUrl + meUrl decode]
        R[receipts/rsResponse + meResponse parse]
    end
    subgraph services
        RR[recordReceipt] --> D
        FR[fetchDueReceipt] --> R
    end
    subgraph fiscal[fiscal adapter]
        F[rsFetcher / meFetcher: HTTP]
    end
    subgraph db
        T[(expenses, receipts, receipt_items)]
    end
    H --> RR --> T
    W --> FR --> F
    FR --> T
```

## Implementation phases

This plan lands after Plans 0009 and 0011, both approved, because it touches the same
`recordExpense.ts`, `bot.ts`, `text.ts` and `messages.ts`. Read those files as 0009 left them.
The receipt path writes only to the user's active ledger, never to a group ledger.

### Phase 1: A pasted Serbian link records the receipt's total
- **Owner skill:** dev
- **What:** A pure decoder for the SUF verify URL, the `receipts` table, a `recordReceipt` service,
  and a branch in the DM text handler: text that is a SUF verify URL records a receipt instead of
  going to `parseExpenseText`. The expense's description is the placeholder «Чек», taken from the
  messages module and passed in by the handler. The category comes from the ledger's most recent
  receipt with the same `merchant_key` (a ledger has no such receipt yet in this phase, so the
  answer is «Другое»).
- **Files touched:** `src/domain/receipts/rsUrl.ts` (+ test), `src/domain/receipts/types.ts`,
  `src/domain/receipts/testing/buildRsVl.ts` (a builder for synthetic payloads, MD5 included),
  `src/db/migrations/<n>_receipts.sql` (the next free number after Plans 0009 and 0011),
  `src/db/receipts.ts` (+ test), `src/services/recordReceipt.ts` (+ test),
  `src/bot/handlers/text.ts`, `src/bot/handlers/receipt.ts`, `src/bot/messages.ts`,
  `src/bot/bot.test.ts`.
- **Done when:**
  - A synthetic `vl` with total raw `8291200`, instant `1790807400000` ms (2026-09-30T22:30:00Z),
    `requestedBy` = `signedBy` = `AAAA1111`, `totalCounter` 16898, invoice type 0 and transaction
    type 0 decodes to `{ country: 'RS', totalMinor: 82912, currency: 'RSD',
    fiscalId: 'AAAA1111-AAAA1111-16898', issuedAt: 2026-09-30T22:30:00Z, merchantKey: 'rs:AAAA1111' }`.
  - These decode to a typed refusal, not a throw: a raw total not divisible by 100 (`8291250`), a
    flipped byte (MD5 mismatch), a truncated payload, invoice types 1 to 4, and transaction type 1
    (refund).
  - A `+` inside `vl` decodes the same whether it arrives as `+`, `%2B`, or a space, which is
    what form-style decoding turns `+` into.
  - With that link sent at 2026-10-01T08:00:00Z, a user in `Europe/Belgrade` gets an expense of
    82912 minor RSD with `occurred_on` 2026-10-01 (local 00:30). A user in `Europe/London` gets
    `occurred_on` 2026-09-30 (local 23:30). The card names the date only for the London user,
    because `occurred_at` stays the message instant.
  - One `receipts` row in state `pending` with `fiscal_id` `AAAA1111-AAAA1111-16898`.
  - Sending the same link again, as a new message, leaves exactly 1 expense and 1 receipt and
    replies «уже записано» with the existing card. The same link from a second user creates a
    second expense in that user's personal ledger (`source_key` carries the ledger id).
  - A receipt whose local issue date is after the local date of the message gets a refusal and
    records nothing.
  - Text that only contains a SUF link next to other words (`кофе https://suf…`) is not a
    receipt: it goes to the normal expense parser, as today.
  - Logs carry the receipt and expense ids and the country, never the amount, URL or fiscal id
    above debug.

### Phase 2: A pasted Montenegrin link
- **Owner skill:** dev
- **What:** The decoder for `mapr.tax.gov.me/ic/#/verify?…` (parameters in the hash fragment),
  wired into the same text branch.
- **Files touched:** `src/domain/receipts/meUrl.ts` (+ test), `src/domain/receipts/index.ts`
  (one `decodeReceiptUrl` that tries both), `src/bot/bot.test.ts`.
- **Done when:**
  - `iic=<32 hex>&tin=02000000&crtd=2026-09-30T23:15:00+02:00&prc=42.50&bu=ab123cd456&…`
    decodes to `{ country: 'ME', totalMinor: 4250, currency: 'EUR', fiscalId: <iic lowercased>,
    issuedAt: 2026-09-30T21:15:00Z, merchantKey: 'me:02000000:ab123cd456' }`.
  - `prc=42` gives 4200 and `prc=42.5` gives 4250. `prc=42.505`, `prc=-1`, `prc=0` and
    `prc=4,50` are refused.
  - `crtd` with its `+` turned into a space (`2026-09-30T23:15:00 02:00`) decodes to the same
    instant.
  - A user in `Europe/Podgorica` gets `occurred_on` 2026-09-30. A user in `Europe/Moscow` gets
    2026-10-01 (local 00:15).
  - An `iic` that differs only in case is the same receipt (1 expense).

### Phase 3: Photos and image files
- **Owner skill:** dev
- **What:** `message:photo`, plus `message:document` with an image MIME type, in DM: download the
  largest size via `getFile`, decode with `zxing-wasm` (ADR-0019), take the first decoded text that
  `decodeReceiptUrl` accepts, and run Phase 1's path. A photo with no readable QR, or with a QR
  that isn't a SUF or EFI receipt, gets one hint: crop closer to the QR, send it as a file, or
  paste the link. Register before `registerNonText`.
- **Files touched:** `package.json`, `pnpm-lock.yaml` (`zxing-wasm` exact), `src/fiscal/qr.ts`
  (+ test), `src/fiscal/qr.fixtures/` (synthetic QR images generated from synthetic URLs, never
  photos of real receipts), `src/bot/handlers/receipt.ts`, `src/bot/bot.ts`,
  `src/bot/messages.ts`, `src/bot/bot.test.ts`, `Dockerfile` (the build-time decode check, plus
  any copy the wasm needs if it doesn't arrive with the prod install), `CLAUDE.md` ("Where things
  live": `src/fiscal/`).
- **Done when:**
  - `qr.ts` decodes the synthetic Serbian-URL fixture JPEG to exactly the source URL, with
    `globalThis.fetch` replaced by a function that throws. This proves the wasm loads from disk,
    not jsDelivr.
  - A fixture with no QR returns "none", not a throw. A fixture holding a non-receipt QR
    (`https://example.com`) gets the not-a-receipt hint.
  - A photo update whose fixture decodes to Phase 1's link records the same expense as the
    pasted link (82912 minor RSD). The same receipt sent as a photo and then as a link gives
    1 expense.
  - A document over 20 MB, or a non-image document, is not downloaded. Over 20 MB it gets the
    hint, and a non-image keeps today's help reply.
  - The decode time for the largest fixture is recorded in the Implementation log, as the
    measurement ADR-0019 marks UNVERIFIED.
  - The download URL, which contains the bot token, is never logged.
  - The Dockerfile's builder stage, after the prod-only install, runs a `RUN node -e` check next
    to the `better-sqlite3` one: it replaces `globalThis.fetch` with a function that throws, loads
    `dist/fiscal/qr.js` against the prod `node_modules`, and decodes the Serbian fixture to its
    URL, exiting non-zero otherwise. The image is built only by the deploy
    (`docker compose up --build`), so a failing check aborts the deploy before the running
    container is replaced. Phase 7 sees it pass on the first real deploy.

### Phase 4: The background fetch fills in the shop and the items
- **Owner skill:** dev
- **What:** Per-country fetchers, response parsers, the worker, and the card update.
  - **Serbia:** a GET on the verify URL with `Accept: application/json` (seller and total), then
    the verify HTML for `viewModel.Token('…')`, then the `/specifications` POST (`invoiceNumber`,
    `token`) for the items.
  - **Montenegro:** the `verifyInvoice` POST (`iic`, `dateTimeCreated` = `crtd`, `tin`).
  - **Parsers:** pure functions over response text. Numbers are read from their JSON source text
    and converted to minor units by the money module (ADR-0018).
  - **The worker:** a timer in `src/bot/receiptWorker.ts`, started in `src/index.ts`. It runs one
    fetch at a time, with a 10 s timeout and an in-flight guard, and stops in the shutdown order
    before polling stops.
  - **On success**, in one transaction: insert the items, set `seller_name` and `fetched`. Set the
    description to the seller name, and recompute `description_key`, only if the description is
    still the placeholder and `updated_at IS NULL`. Re-run `suggestCategory` on the seller name
    only if `category_set_at = created_at` and the category came from the fallback. Then edit the
    card, if the expense is live and the card's chat and message ids are stored.
  - **On failure** (timeout, non-2xx, empty body, unparseable): `attempts + 1`, rescheduled at
    +1 min, +5 min, +30 min, +2 h, then +12 h. The failure after the +12 h attempt marks the
    receipt `failed`. That's 6 attempts over 14 h 36 min.
- **Files touched:** `src/domain/receipts/rsResponse.ts` (+ test), `src/domain/receipts/meResponse.ts`
  (+ test), `src/domain/money.ts` (+ test: a decimal source string to minor units, if the parser
  doesn't already cover it), `src/fiscal/rsFetcher.ts`, `src/fiscal/meFetcher.ts` (+ tests with an
  injected `fetch` and synthetic JSON/HTML bodies), `src/services/fetchDueReceipt.ts` (+ test),
  `src/db/receipts.ts`, `src/db/receiptItems.ts` (+ test), `src/db/migrations/<n>_receipts.sql`
  (items table, if not created in Phase 1), `src/bot/receiptWorker.ts`, `src/bot/handlers/receipt.ts`
  (store the card's message id), `src/bot/messages.ts`, `src/index.ts`.
- **Done when:**
  - A synthetic Serbian specifications body with items totals `"total": 799.99` and
    `"total": 29.13` parses to 79999 and 2913 minor RSD, and `"quantity": 0.535` is stored as the
    text `0.535`. `"total": 0.29` parses to exactly 29. In JS, `0.29 * 100` is
    `28.999999999999996`, so this vector catches any path through a float. `"total": 1.005` (three
    fraction digits for an exponent-2 currency) is refused as unparseable, which fails the fetch.
  - A synthetic Montenegrin body with `seller.name` «Test Market» and 2 items stores 2
    `receipt_items` rows in source order and sets the description to «Test Market».
  - A user who changed the category before the fetch keeps it, and so does a user who edited the
    description: no field changes except `seller_name` and the items.
  - A fetched total that differs from `amount_minor` leaves `amount_minor` unchanged and logs a
    warn with the receipt id only.
  - With a fake clock and a fetcher that always fails, the receipt is attempted at t0, +1 min,
    +6 min, +36 min, +2 h 36 min and +14 h 36 min, then is `failed` with `attempts` 6, and the
    worker makes no seventh call.
  - Restarting with a receipt left `pending` mid-fetch fetches it again, and items are inserted
    once (the state flip is compare-and-set on `pending`).
  - No test touches the network: the fetchers are tested with an injected `fetch`, and the
    service with a fake fetcher.

### Phase 5: [Позиции] and [Повторить] on the card
- **Owner skill:** dev
- **What:** A fetched receipt's card shows `Магазин · N позиций` and a [Позиции] button. Tapping
  it edits the card into the item list (name, quantity when it isn't 1, line total), paged to stay
  under 4096 characters, with [Назад]. A `failed` receipt's card shows «Позиции не загрузились»
  and [Повторить], which resets it to `pending` with `attempts` 0 and kicks the worker. Item names
  go through the ADR-0012 escaping seam.
- **Files touched:** `src/bot/callbackData.ts` (`exp:items:<uuid>:<page>`, at most 51 bytes;
  `exp:rcretry:<uuid>`, 48 bytes), `src/bot/handlers/card.ts`, `src/bot/handlers/receipt.ts`,
  `src/services/fetchDueReceipt.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - A receipt with 120 items whose names are 60 characters each pages so that every page's
    rendered HTML is at most 4096 characters, and the pages together list all 120 in order.
  - An item named `<b>Хлеб & Co</b>` renders escaped.
  - A double tap on [Повторить] leaves one `pending` receipt with `attempts` 0, and the worker
    fetches it once.
  - [Позиции] on a card whose expense another user owns answers like the existing card taps do
    for a foreign expense, and reveals no items.

### Phase 6: Help and the README
- **Owner skill:** dev
- **What:** `/help` gains one line: send a photo or link of a Serbian or Montenegrin receipt. This
  also pays the `/help` copy owed by Plans 0003 and 0004: past dates (`450 такси вчера`) and
  [Изменить]/[Категория] on the card. The README gets a "Receipts" section that names the two
  external endpoints the bot calls. No version bump here: that's the close ceremony.
- **Files touched:** `src/bot/messages.ts`, `src/bot/messages.test.ts`, `README.md`.
- **Done when:** `/help` mentions receipts, past dates and the card's edit buttons, and stays
  under 4096 characters. The README lists `suf.purs.gov.rs` and `mapr.tax.gov.me` as the only
  outbound hosts besides Telegram.

### Phase 7: Real receipts in production
- **Owner skill:** human
- **Blocks merge:** no
- **What:** After deploy, scan real receipts: one Serbian and one Montenegrin as photos, one of
  each as a pasted link, and one long Serbian receipt photographed whole.
- **Files touched:** none.
- **Done when:** The deploy's image build ran Phase 3's decode check and passed. Each receipt
  records the printed total, and the card gains the shop name and the right item count within a
  minute. A rescan says «уже записано». The user notes in the Implementation
  log which photos failed to decode and whether "send as file" fixed them. This is the evidence
  ADR-0019's acceptance waits for.

## Data shapes

```sql
-- illustrative
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id),
  country TEXT NOT NULL CHECK (country IN ('RS', 'ME')),
  fiscal_id TEXT NOT NULL,          -- RS invoice number; ME iic, lowercased
  merchant_key TEXT NOT NULL,       -- rs:<requestedBy> | me:<tin>:<bu>
  verify_url TEXT NOT NULL,         -- what the fetcher needs; never logged
  issued_at TEXT NOT NULL,          -- UTC instant from the QR
  seller_name TEXT,
  fetch_state TEXT NOT NULL CHECK (fetch_state IN ('pending', 'fetched', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_fetch_at TEXT,
  card_chat_id INTEGER, card_message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX receipts_due ON receipts(fetch_state, next_fetch_at);
CREATE TABLE receipt_items (
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity TEXT NOT NULL,           -- decimal string, e.g. '0.535': not money
  total_minor INTEGER NOT NULL,     -- in the expense's currency
  PRIMARY KEY (receipt_id, position)
);
```

```ts
// illustrative
type DecodedReceipt = {
  country: 'RS' | 'ME';
  fiscalId: string;
  merchantKey: string;
  totalMinor: number; // integer
  currency: 'RSD' | 'EUR';
  issuedAt: Date; // UTC
  verifyUrl: string;
};
// source_key = `rcpt:${country}:${fiscalId}:${ledgerId}`  (ADR-0018)
```

## Risks & open questions

- **Undocumented endpoints.** Either site can change markup or API. Fetchers fail closed: the
  expense keeps its total and the receipt goes `failed`. Plan 0001's Telegram error boundary
  doesn't cover the worker, so the worker catches and logs per receipt.
- **Montenegro's currency** is inferred to be EUR, not documented. If a fetched
  `currency.code` isn't EUR, log a warn by id and keep the QR amount. Revisit if it ever fires.
- **Rate limiting** by the tax sites is unknown. One fetch at a time and the backoff are the
  mitigation. The `User-Agent` names the bot honestly.
- **Card clobbering.** The worker's edit replaces whatever state the card is in, for example an
  open category picker (ADR-0018 negative). This is accepted for v1. If it bites, skip the edit
  while a flow (ADR-0009) is pending on that expense.
- **Money.** The Serbian QR total has 4 implied decimals. A total not divisible by 100 is refused
  rather than rounded, and the user can type the amount. Item amounts are read from source text,
  never through a JS number.
- **Time.** `occurred_on` is the receipt instant in the *user's* timezone, not the shop's, per the
  non-negotiable. `occurred_at` stays the message instant, so the card names the date of an old
  receipt.
- **Privacy.** The verify URL, the fiscal ids, seller names and item names are expense data. They
  go to the DB and never above debug in logs. Test fixtures are synthetic: no real receipt URL,
  photo or JSON body is committed. That includes the public `turanjanin` fixture, which is a real
  receipt.
- **Event-loop cost of decoding** a large photo (ADR-0019). Phase 3 measures it. If it's above
  about 1 s, the next plan moves decoding to a worker thread.
- **Plan 0011 budgets** see a receipt the moment it's recorded, because the amount is final then.
  Nothing in the enrichment changes the amount.

## What this plan does NOT do

- **Russia (ФНС) and Kazakhstan (fiscal data operators).** Their QR codes also carry the total and
  instant offline, so a later plan can add total-only decoding cheaply. Line items for Russia need
  an authenticated ФНС account or a paid API: that's an ADR of its own.
- **Splitting a receipt into several expenses by category.** It builds on the stored items. A
  future plan.
- **Receipts in group chats** (Plan 0009's group composer ignores photos).
- **Refunds, copies, pro-forma and advance invoices.** They're refused with a message. Refunds
  would need negative expenses, and `amount_minor > 0` forbids them today.
- **Onboarding** (Plan 0015), which will teach this feature once it exists.
- **FX conversion** of RSD and EUR receipts into a home currency (ADR-0003, still unplanned).

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: A pasted Serbian link records the receipt's total | dev | done | 7b2687f |
| 2: A pasted Montenegrin link | dev | done | committed with this row |
| 3: Photos and image files | dev | not started | |
| 4: The background fetch fills in the shop and the items | dev | not started | |
| 5: [Позиции] and [Повторить] on the card | dev | not started | |
| 6: Help and the README | dev | not started | |
| 7: Real receipts in production | human | not started | |

### Notes

- Phase 1: the migration is `0010_receipts.sql` and creates `receipt_items` as well as
  `receipts`. `src/db/categories.test.ts` (not in Files touched) pinned the full list of
  migrations a pre-0009 DB applies, `['0009']`; it now asserts only that the first one is `0009`.
- Phase 1: the «уже записано» reply reads «Уже записано.» on its own line above the card.
- Phase 2: `src/bot/handlers/text.ts` (not in Files touched) switched its import from
  `decodeRsUrl` to `decodeReceiptUrl`, which is the wiring the phase names. `prc=42.505` is
  refused as `fractionalTotal`, the other refused `prc` values as `malformed`.

### Close triggers

- **What shipped:**
- **User-visible surface changed:**
- **Gate at the tip:**
- **Outstanding `human` phases:**

## Followups
