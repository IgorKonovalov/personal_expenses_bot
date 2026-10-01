# Architecture Decision Records

One decision per file, with its rejected alternatives. Append-only once accepted: supersede,
never rewrite. **Rows are pointers:** link, title (the ADR's H1), status and date.

- **Next free number:** `0020`

| ADR | Title | Status |
|---|---|---|
| [0001](0001-tech-stack.md) | Tech stack: Node 24 + strict TypeScript, grammY long polling, better-sqlite3 | accepted (2026-09-29) |
| [0002](0002-ledgers-and-identity.md) | Expenses belong to ledgers; users select an active ledger | accepted (2026-09-29) |
| [0003](0003-currency-conversion-at-report-time.md) | Store original amounts; convert to the viewer's home currency at report time | accepted (2026-09-29) |
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
| [0014](0014-group-chats-bind-to-shared-ledgers.md) | A group chat binds to one shared ledger, and the chat, not the active ledger, routes its messages | proposed (2026-09-30) |
| [0015](0015-shared-ledgers-carry-a-timezone.md) | A shared ledger carries its own timezone, used for its dates and periods | proposed (2026-09-30) |
| [0016](0016-readiness-runs-before-a-plan-is-queued.md) | The readiness check runs before a plan is queued, and `run` refuses a plan without one | accepted (2026-10-01) |
| [0017](0017-budgets-payday-periods-cumulative-allowance.md) | Budgets run over payday periods, with a cumulative daily allowance in the budget's currency | proposed (2026-09-30) |
| [0018](0018-receipts-record-offline-enrich-async.md) | A fiscal receipt records its total from the QR at once, and line items arrive by a background fetch | proposed (2026-10-01) |
| [0019](0019-qr-decoding-zxing-wasm.md) | Decode receipt QR codes with zxing-wasm, with its wasm binary loaded from node_modules | proposed (2026-10-01) |
