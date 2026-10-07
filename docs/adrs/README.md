# Architecture Decision Records

One decision per file, with its rejected alternatives. Append-only once accepted: supersede,
never rewrite. **Rows are pointers:** link, title (the ADR's H1), status and date.

- **Next free number:** `0041`

| ADR | Title | Status |
|---|---|---|
| [0001](0001-tech-stack.md) | Tech stack: Node 24 + strict TypeScript, grammY long polling, better-sqlite3 | accepted (2026-09-29) |
| [0002](0002-ledgers-and-identity.md) | Expenses belong to ledgers; users select an active ledger | accepted (2026-09-29) |
| [0003](0003-currency-conversion-at-report-time.md) | Store original amounts; convert to the viewer's home currency at report time | accepted (2026-09-29), target currency superseded by 0022 |
| [0004](0004-amount-parsing-rule.md) | Amount parsing: one decimal separator, space thousands, ask on ambiguity | accepted (2026-09-29) |
| [0005](0005-ux-telegram-lane.md) | Add a ux-telegram lane that designs and reviews chat UX but writes no code | proposed (2026-09-29) |
| [0006](0006-production-runs-compiled-js.md) | Production runs tsc-compiled JavaScript from dist/ | accepted (2026-09-30) |
| [0007](0007-categories-belong-to-ledgers.md) | Categories belong to ledgers, seeded from a preset and editable | accepted (2026-09-30) |
| [0008](0008-category-suggestion-from-history.md) | Suggest a category from the ledger's history, then keyword rules, then «Другое» | accepted (2026-09-30) |
| [0009](0009-persisted-flow-sessions.md) | Multi-step flows keep their state in SQLite, one pending flow per user | accepted (2026-09-30) |
| [0010](0010-approved-plans-run-under-a-forked-conductor-on-trial.md) | Approved plans run under a conductor forked from Ritmolux, on trial before any package | accepted (2026-09-30) |
| [0011](0011-navigation-model.md) | Navigation: a persistent menu, expense cards, one screen anchor per user | accepted (2026-09-30) |
| [0012](0012-html-rendering-seam.md) | Telegram HTML through one escaping seam | accepted (2026-09-30) |
| [0013](0013-version-announcements-at-boot.md) | Announce each new version to the admin at boot, recorded in SQLite | accepted (2026-09-30) |
| [0014](0014-group-chats-bind-to-shared-ledgers.md) | A group chat binds to one shared ledger, and the chat, not the active ledger, routes its messages | accepted (2026-10-01) |
| [0015](0015-shared-ledgers-carry-a-timezone.md) | A shared ledger carries its own timezone, used for its dates and periods | accepted (2026-10-01) |
| [0016](0016-readiness-runs-before-a-plan-is-queued.md) | The readiness check runs before a plan is queued, and `run` refuses a plan without one | accepted (2026-10-01) |
| [0017](0017-budgets-payday-periods-cumulative-allowance.md) | Budgets run over payday periods, with a cumulative daily allowance in the budget's currency | accepted (2026-10-01) |
| [0018](0018-receipts-record-offline-enrich-async.md) | A fiscal receipt records its total from the QR at once, and line items arrive by a background fetch | accepted (2026-10-01) |
| [0019](0019-qr-decoding-zxing-wasm.md) | Decode receipt QR codes with zxing-wasm, with its wasm binary loaded from node_modules | proposed (2026-10-01) |
| [0020](0020-sealed-ledgers-write-open-read-locked.md) | An encrypted ledger is sealed to its own public key: recording stays open, reading needs the owner's passphrase | accepted (2026-10-02) |
| [0021](0021-bank-sms-template-parsers-plain-expense.md) | A bank SMS is read by an exact per-template parser and recorded as a plain expense keyed by its content | accepted (2026-10-01) |
| [0022](0022-fx-nbs-middle-rate-ledger-currency.md) | Reports convert into the ledger's default currency at the NBS middle rate of each expense's day | accepted (2026-10-01) |
| [0023](0023-budgets-count-converted-spending.md) | Budgets count spending in every currency, converted into the budget's currency | accepted (2026-10-01) |
| [0024](0024-admission-lives-in-the-database-via-invite-codes.md) | Admission lives in the database, granted by admin-made invite codes | accepted (2026-10-06) |
| [0025](0025-static-mini-app-fragment-in-senddata-out.md) | A static Mini App with no backend: data arrives in the URL fragment and leaves by sendData | proposed (2026-10-01) |
| [0026](0026-export-csv-and-hand-rolled-xlsx.md) | Export writes CSV and a hand-rolled XLSX, with no spreadsheet dependency | accepted (2026-10-03) |
| [0027](0027-donations-only-funding.md) | The bot is funded by donations only: no paid tier, and a donation unlocks nothing | accepted (2026-10-06) |
| [0028](0028-contextual-tips-registry.md) | Contextual tips are a registry of conditions, shown as one capped message, seen when sent | accepted (2026-10-06) |
| [0029](0029-tags-on-the-expense-row.md) | Tags are `#words` stripped from the expense text and stored on the expense row | accepted (2026-10-06) |
| [0030](0030-debts-as-operations-settle-up-per-currency.md) | Debts are signed operations balanced per person and currency; group settle-up splits equally per currency | accepted (2026-10-06) |
| [0031](0031-local-time-scheduler.md) | One minute-tick scheduler fires per-ledger jobs at a local time, keyed by occurrence date | accepted (2026-10-06) |
| [0032](0032-statement-rows-match-recorded-expenses.md) | A statement row counts as already recorded when a live expense matches its amount and currency within one day | accepted (2026-10-06) |
| [0033](0033-pdf-statements-via-pdfjs-dist.md) | PDF statements are read with `pdfjs-dist`, imported lazily and only by the statements adapter | accepted (2026-10-06) |
| [0034](0034-qr-retry-on-preprocessed-pixels-jpeg-js.md) | Retry an unread receipt QR on preprocessed pixels, decoded with jpeg-js | accepted (2026-10-05) |
| [0035](0035-recurring-occurrences-sealed-under-their-rule.md) | A sealed recurring occurrence opens under its rule's binding, not its own expense id | accepted (2026-10-06) |
| [0036](0036-stay-on-node-memory-work-targets-heavy-jobs.md) | Stay on Node; memory work targets the heavy jobs, not the runtime | accepted (2026-10-06) |
| [0037](0037-first-time-notices-and-transient-replies.md) | One-time notices are rows in `user_notices`, and transient replies are deleted by an in-process timer | accepted (2026-10-06) |
| [0038](0038-collapse-with-expandable-quotes-opt-in-tidy-chat.md) | Long lists collapse in Telegram's expandable quote, and the user's recorded messages are deleted only when they opt in | accepted (2026-10-06) |
| [0039](0039-products-from-keyword-rules-and-per-user-overrides.md) | Receipt items map to products through built-in keyword rules plus per-user overrides, and unit prices are computed in exact integers | accepted (2026-10-07), with an outcome |
| [0040](0040-expense-card-inside-a-screen-anchor.md) | An expense card can be drawn inside a screen anchor, and only there does it carry a back row | proposed (2026-10-06) |
