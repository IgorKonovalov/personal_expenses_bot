# ADR-0021: A bank SMS is read by an exact per-template parser and recorded as a plain expense keyed by its content

> **Status:** accepted
> **Date:** 2026-10-01
> **Related plan(s):** [Plan 0021](../plans/done/0021-bank-sms-card-purchase.md)

## Context

Users paste or forward their bank's card-purchase SMS into the private chat. Today such a text
falls through to the free-text parser, which finds no leading amount and answers with `/help`.
The first template seen is a Serbian card-purchase SMS: a header line `Koriscenje kartice
<masked card>`, then labelled lines `Datum:` (a local date and time), `Iznos:` (the amount, a
dot-grouped, comma-decimal number and an ISO-4217 code), `Raspolozivo:` (the available balance)
and `Mesto:` (the merchant). The amount's currency can differ from the card's (a USD charge on an
RSD card).

One SMS carries two amounts (charge and balance), so anything that guesses "the amount" from the
text can pick the wrong one. ADR-0004 already says structured sources parse exactly, not by the
free-text rule. The same SMS is easy to paste twice, and later a phone automation may forward it
too, so dedupe can't key on the Telegram message.

## Decision

Each bank SMS template has its own pure parser under `src/domain/bankSms/`. A parser recognises
its template by the header line and then reads the labelled lines exactly. It returns a purchase
(instant, amount in minor units, currency, merchant), a `malformed` or `unsupportedCurrency`
refusal when the header matches but the body doesn't, or `notBankSms`. The template fixes the
bank's timezone, so `Datum` becomes a UTC instant, and the expense's date is that instant's local
date in the ledger's effective timezone. A purchase records an ordinary expense in the original
amount and currency (ADR-0003), with no side table. Its `source_key` is
`sms:<template>:<sha256 of the normalised fields>:<ledgerId>`, so the same SMS pasted again into
the same ledger, by hand or later by automation, returns the stored expense. The card mask and the
balance are read past and never stored or logged.

## Consequences

### Positive
- The charge is never confused with the balance: only the `Iznos:` line is an amount.
- No migration. An SMS expense is an ordinary expense to every report, edit and budget path.
- Dedupe holds across paste, forward and a future automated delivery, because the key is the
  content, not the message.
- A new bank is a new parser file with synthetic fixtures. Nothing else changes shape.

### Negative
- Only templates someone has written a parser for are read. Every other bank's SMS still gets the
  `/help` answer until a sample arrives and a parser is written.
- A wording change by the bank silently turns its SMS back into `/help` (or `malformed` if the
  header survives). Nothing alerts us.
- No record of which card paid. A per-card report would need the side table rejected below.
- The hashed `source_key` is low-entropy (time, amount, merchant). Someone holding the database
  file can confirm a guessed purchase against it. This matters once Plan 0019 seals amounts, and
  sits beside the receipts table, whose plaintext `verify_url` already carries a total.
- Two genuinely identical purchases (same card, second, amount and merchant) record once.

## Alternatives considered

### Alternative A: a `bank_sms` side table, like `receipts`
A row per SMS with the card suffix, the raw merchant and the bank, linked to the expense. It would
allow per-card reports and merchant-to-category memory keyed on the raw merchant. It lost because
it stores more private data at rest (the card suffix) for features nobody has asked for. It also
adds a migration and gives Plan 0019 another table to seal. The description already carries the
merchant, and category memory already keys on the description.

### Alternative B: loose extraction for any bank
Find an "amount CODE" pair, a date and a merchant-like line in any multi-line text, with no
per-bank template. It would cover unknown banks at once. It lost because this very SMS has two
amounts and nothing generic tells charge from balance. A misread records a wrong number silently,
which ADR-0004 exists to prevent.

### Alternative C: dedupe on the Telegram message id
The free-text path keys on `tg:<chat>:<message>`. It lost because the same SMS pasted twice, or
pasted and later auto-forwarded, would record twice.
