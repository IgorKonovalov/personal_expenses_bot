# ADR-0018: A fiscal receipt records its total from the QR at once, and line items arrive by a background fetch

> **Status:** accepted (2026-10-01)
> **Date:** 2026-10-01
> **Related plan(s):** [Plan 0014](../plans/done/0014-fiscal-receipts-rs-me.md)

## Context

A Serbian or Montenegrin fiscal receipt carries a QR code that encodes a verification URL. The URL
alone gives the total, the issue instant and a fiscal id, with no network call. In Serbia these
are in the binary `vl` payload (the total is `amount x 10000` as a little-endian UInt64, the
instant is Unix milliseconds big-endian, and the invoice number is `requestedBy-signedBy-totalCounter`).
In Montenegro they are the `prc`, `crtd` and `iic` parameters of the URL's hash fragment. The shop
name and the line items exist only on the tax authority's site: `suf.purs.gov.rs` (a JSON verify
response plus a `/specifications` POST) and `mapr.tax.gov.me/ic/api/verifyInvoice`. Both are
undocumented public endpoints with no SLA.

grammY's long polling handles updates one at a time. A tax-site request inside a handler stalls
every user's messages for as long as the site takes, and a site that is down would leave the
receipt unrecorded.

`expenses.source_key` is globally `UNIQUE`, and `recordExpense` treats a key seen in another user's
ledger as a bug. A receipt id alone can't be the key: two family members may scan the same
receipt into their own personal ledgers.

## Decision

We record a receipt in two steps.

1. **Record (in the handler, offline).** A pure domain decoder turns the URL into
   `{ country, fiscalId, totalMinor, currency, issuedAt, merchantKey }`. The service records one
   expense with that total, `occurred_on` = the issue instant's local date in the user's timezone,
   and `source_key = rcpt:<country>:<fiscalId>:<ledgerId>`. It also writes a `receipts` row in
   state `pending`. The same receipt in the same ledger, whether as a redelivered update, a second
   photo or the pasted link, is a duplicate and gets the existing card.
2. **Enrich (in the background).** An in-process worker picks up due `pending` receipts one at a
   time. It fetches through a per-country fetcher with a timeout, and in one transaction stores
   the items, the seller name and `fetched`. It replaces the placeholder description with the seller
   name and re-suggests the category, but only for fields the user hasn't changed since recording.
   It then edits the card. A failure reschedules with backoff. After the last attempt it marks the
   receipt `failed`, and the card offers a manual retry.

Amounts in tax-site JSON are JSON numbers. They are read from their **source text**
(`JSON.parse`'s reviver `context.source`, available in Node 24) and converted by the money module,
so no float ever exists. The QR's total stays the expense amount. A fetched total that disagrees is
logged by id and does not overwrite it.

## Consequences

### Positive
- The card appears as soon as the QR is read, and a tax-site outage costs only the line items.
- The handler stays offline and fast. Retries survive restarts because the queue is the
  `receipts` table.
- Dedupe by fiscal id and ledger also catches the same receipt sent as a photo and then as a link.

### Negative
- A receipt has a visible intermediate state («Чек» with no shop name) and a second card edit,
  which can replace a category picker the user opened in the meantime.
- Two writers touch an expense: the user and the worker. The worker's "unchanged since recording"
  checks (`updated_at IS NULL`, `category_set_at = created_at`) are now load-bearing.
- A worker loop is new operational surface: a timer, shutdown order and an in-flight guard.
- We depend on two undocumented endpoints. A markup or API change silently degrades receipts to
  total-only until a fetcher is fixed.

## Alternatives considered

### Alternative A: Fetch, then record once
The handler fetches with a timeout of about 8 s and records shop, items and category in one write,
falling back to the total on failure. It lost because sequential long polling makes every slow
fetch a stall for all users, and a down site turns into a burst of total-only receipts that need
manual retries.

### Alternative B: One expense per line item
Each item becomes its own expense in its own category. It lost on the user's call: one receipt is
one expense for v1. A split-by-category flow can build on the stored items later.

### Alternative C: A third-party receipt aggregator API
Paid aggregators exist for Russia's ФНС, but we found none covering Serbia and Montenegro. Fetching
directly from both public endpoints is the only option for these countries.
