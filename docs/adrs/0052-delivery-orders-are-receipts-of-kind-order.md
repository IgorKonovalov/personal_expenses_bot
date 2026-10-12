# ADR-0052: A delivery order is a `receipts` row of kind `order`, with no fiscal fields

> **Status:** proposed
> **Date:** 2026-10-12
> **Related plan(s):** [Plan 0051](../plans/0051-delivery-order-pdf-import.md)

## Context

Plan 0051 imports a Wolt order confirmation PDF («Potvrda porudžbine») as one expense with item
lines. Each line has a dish name, a quantity and a price, which is exactly what a fiscal receipt's
`receipt_items` row holds. Everything that shows or counts items already reads `receipts` +
`receipt_items`: the expense card and its [Позиции] pager, period items, `/prices`, the export,
sealing, ledger deletion and the products coverage tool.

`receipts` can't hold an order as it stands. `country` (limited to `RS`/`ME` by a CHECK),
`fiscal_id` and `verify_url` are NOT NULL (migration `0010_receipts.sql`), and the sealed payload
requires `verifyUrl` to be a string (`src/domain/sealing.ts`). An order has no fiscal id and no
verification link. The paper fiscal receipt that carries them is in the delivery bag, not in the
PDF.

An order also needs its own duplicate key. A re-sent PDF must not record twice. When the user says
the PDF is an expense they already typed, the items attach to that expense, whose `source_key` is
not the order's. So the order's key has to live on the receipt row, not only on the expense.

## Decision

> `receipts` gains `kind` (`'fiscal' | 'order'`) and `order_key`. A fiscal row keeps every fiscal
> column NOT NULL, and an order row has them NULL. A table-level CHECK enforces both shapes. An
> order row is born `fetch_state = 'fetched'` with `seller_name` set, so the fetch worker never
> sees it. Its items go to `receipt_items` unchanged. `order_key` is `<source>:<order id>:<ledgerId>`
> (for example `wolt-rs:0123…:<ledgerId>`). A partial unique index on it makes a re-sent PDF a
> duplicate, whether the order created its expense or was attached to an existing one. Order
> items never count toward product prices, whatever the expense's category.

The rebuild follows migration `0012`'s copy-aside pattern, since SQLite cannot drop a NOT NULL. In
TypeScript the stored receipt becomes a union on `kind`, so every reader of `verifyUrl`, `country`
or `fiscalId` has to narrow. A missed reader fails to compile instead of failing at runtime.

## Consequences

### Positive
- The card, [Позиции], period items, the export, sealing and deletion show and carry order items
  with no second code path.
- One duplicate check covers both a new order expense and an attached one.
- The fiscal fetch path doesn't change: it selects `fetch_state = 'pending'`, and an order is never
  pending.

### Negative
- A table rebuild of `receipts` on a live database, with `receipt_items` pointing at it. A rebuild
  that loses a row loses receipts. The migration test has to prove that the row counts and the ids
  survive.
- Every `verifyUrl` consumer (export, sealing) handles null. The sealed payload format widens, so
  `verifyUrl` may be null, and the opener has to accept both shapes. Payloads sealed before the
  change still parse, because they always carry a string.
- `RECEIPTS_PER_DAY` counts rows created by the user, so orders count toward the cap. That cap
  exists to protect the fiscal sites, which an order never calls. This is accepted, because 20 a
  day is far above any real use.
- Excluding order items from `/prices` is a rule by kind, beside ADR-0051's rule by category. That
  makes two reasons an item is left out.

## Alternatives considered

### Alternative A: Separate `delivery_orders` and `delivery_order_items` tables
This leaves the fiscal table untouched. It lost because every reader of items listed above would
need a second source merged into its own, and a missed one shows a card with no items or an
export with a hole.

### Alternative B: Orders in `receipts` as they are, with placeholder fiscal values
Insert `country = 'RS'`, the order id as `fiscal_id` and an empty `verify_url`. This needs no
migration. It lost because the rows lie: the export shows an empty receipt link, the source key
looks fiscal, and the next reader that trusts `fiscal_id` (a retry, a re-fetch) acts on a value
that isn't one.

### Alternative C: Items folded into the expense description
This needs no storage at all. It lost because the card's [Позиции], period items and the export
would never see the dishes, which are the point of importing the PDF instead of typing the total.
