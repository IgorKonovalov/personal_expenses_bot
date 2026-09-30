# Architecture Decision Records

One decision per file, with its rejected alternatives. Append-only once accepted: supersede,
never rewrite. **Rows are pointers:** link, title (the ADR's H1), status and date.

- **Next free number:** `0013`

| ADR | Title | Status |
|---|---|---|
| [0001](0001-tech-stack.md) | Tech stack: Node 24 + strict TypeScript, grammY long polling, better-sqlite3 | accepted (2026-09-29) |
| [0002](0002-ledgers-and-identity.md) | Expenses belong to ledgers; users select an active ledger | accepted (2026-09-29) |
| [0003](0003-currency-conversion-at-report-time.md) | Store original amounts; convert to the viewer's home currency at report time | accepted (2026-09-29) |
| [0004](0004-amount-parsing-rule.md) | Amount parsing: one decimal separator, space thousands, ask on ambiguity | accepted (2026-09-29) |
| [0005](0005-ux-telegram-lane.md) | Add a ux-telegram lane that designs and reviews chat UX but writes no code | proposed (2026-09-29) |
| [0006](0006-production-runs-compiled-js.md) | Production runs tsc-compiled JavaScript from dist/ | proposed (2026-09-29) |
| [0007](0007-categories-belong-to-ledgers.md) | Categories belong to ledgers, seeded from a preset and editable | accepted (2026-09-30) |
| [0008](0008-category-suggestion-from-history.md) | Suggest a category from the ledger's history, then keyword rules, then «Другое» | accepted (2026-09-30) |
| [0009](0009-persisted-flow-sessions.md) | Multi-step flows keep their state in SQLite, one pending flow per user | accepted (2026-09-30) |
| [0010](0010-approved-plans-run-under-a-forked-conductor-on-trial.md) | Approved plans run under a conductor forked from Ritmolux, on trial before any package | proposed (2026-09-29) |
| [0011](0011-navigation-model.md) | Navigation: a persistent menu, expense cards, one screen anchor per user | accepted (2026-09-30) |
| [0012](0012-html-rendering-seam.md) | Telegram HTML through one escaping seam | accepted (2026-09-30) |
