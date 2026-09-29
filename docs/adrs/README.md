# Architecture Decision Records

One decision per file, with its rejected alternatives. Append-only once accepted: supersede,
never rewrite. **Rows are pointers:** link, title (the ADR's H1), status and date.

- **Next free number:** `0006`

| ADR | Title | Status |
|---|---|---|
| [0001](0001-tech-stack.md) | Tech stack: Node 24 + strict TypeScript, grammY long polling, better-sqlite3 | proposed (2026-09-29) |
| [0002](0002-ledgers-and-identity.md) | Expenses belong to ledgers; users select an active ledger | proposed (2026-09-29) |
| [0003](0003-currency-conversion-at-report-time.md) | Store original amounts; convert to the viewer's home currency at report time | proposed (2026-09-29) |
| [0004](0004-amount-parsing-rule.md) | Amount parsing: one decimal separator, space thousands, ask on ambiguity | proposed (2026-09-29) |
| [0005](0005-ux-telegram-lane.md) | Add a ux-telegram lane that designs and reviews chat UX but writes no code | proposed (2026-09-29) |
