# ADR-0029: Tags are `#words` stripped from the expense text and stored on the expense row

> **Status:** accepted (2026-10-06, at the close of Plan 0012)
> **Date:** 2026-10-01
> **Related plan(s):** Plan 0012 ([0012-tags-projects.md](../plans/done/0012-tags-projects.md))

## Context

Plan 0012 adds tags: a label that cuts across categories (`#отпуск`, `#ремонт`). An expense can
carry several, a tag is created on first use, and a tag belongs to its ledger. Two decisions shape
everything else: how a tag is written in the expense text (`parseExpenseText`), and where
tags are stored.

Storage is complicated by sealed ledgers (ADR-0020). A tag name is user data (`#лечение`,
`#развод`), so in a sealed ledger it must be sealed with the description and category. A
normalized `tags` / `expense_tags` pair would leak there, because both the names and the links
are readable. So a sealed ledger has to carry tags inside the sealed payload whatever else we
choose.

Category learning (ADR-0008) is keyed on the description. A tag left inside it would split one
habit (`кофе`) into many keys (`кофе #отпуск`, `кофе #рим`).

## Decision

A tag is a word that starts with `#`, followed by 1 to 32 letters, digits or `_`, anywhere after
the amount and optional currency. It is removed from the description before the date suffix
(the last word, Plan 0004) and the description key are computed. Names are normalized to
NFC lower case, so `#Отпуск` and `#отпуск` are one tag. An expense holds at most 5 distinct tags.

In a plaintext ledger, an expense's tags are stored in a nullable `expenses.tags` column, as
the space-joined normalized names in first-written order. In a sealed ledger they go inside the
sealed payload, and the column stays NULL. Every tag read (the `/tags` list, the per-tag report,
export) loads the ledger's expenses through the usual read seam and groups them in the domain.
SQL never filters by tag. A sticky tag (`/tag отпуск`) is stored per ledger member in plaintext
ledgers. In sealed ledgers it lives in process memory only, so it is gone after a restart.

## Consequences

### Positive
- One code path for plaintext and sealed ledgers. The tag report is a domain function over the
  expenses, tested without a database.
- No new tables. A tag exists exactly while some expense carries it, so there is no orphan
  cleanup and no rename cascade.
- Category learning stays keyed on the bare description.

### Negative
- `/tags` reads the whole ledger to list tags and totals. That's fine for a personal ledger's
  thousands of rows, and it gets slow somewhere in the hundreds of thousands, which no ledger here
  approaches.
- Renaming a tag means rewriting every expense that carries it. This plan offers no rename.
- `#` can no longer appear at the start of a description word. `450 #1 в очереди` now tags `1`.
- In a sealed ledger a sticky tag doesn't survive a restart. The confirmation stops showing it,
  which is how the user notices.

## Alternatives considered

### Alternative A: normalized `tags` and `expense_tags` tables
SQL reports and a natural place for rename and archive. It lost because a sealed ledger can't use
them without leaking names and links, so it would need the payload path too. That's two
implementations and two test suites for one feature.

### Alternative B: tags left in the description, matched by text
No parser change and no column. It lost because it breaks category learning by description key,
and because a report that matches `#отпуск` inside free text can't tell a tag from a hashtag
quoted in a note.
