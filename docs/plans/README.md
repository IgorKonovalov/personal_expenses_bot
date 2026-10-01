# Plans

Phased implementation plans written by the `architect` skill and implemented by `dev`. A plan is
`NNNN-<slug>.md`. It moves to `done/` at its close ceremony. **Rows are pointers:** link, title,
status and date. What a plan did lives in the plan.

- **Next free number:** `0021`

## Active

| Plan | Title | Status |
|---|---|---|
| [0012](0012-tags-projects.md) | Tags for projects: `#отпуск` on an expense, and a report per tag | draft, stub (2026-09-30) |
| [0013](0013-debts.md) | Debts: who owes whom, closed in the currency they were opened in | draft, stub (2026-09-30) |
| [0019](0019-encrypted-personal-ledger.md) | Encrypted personal ledger: recording stays open, reading needs the owner's passphrase | approved (2026-10-01) |
| [0015](0015-onboarding.md) | Onboarding: confirm the setup on first contact, then teach each feature when it becomes relevant | draft, stub (2026-10-01) |
| [0020](0020-receipt-urls-wrapped-vl-and-port.md) | Receipt links with a line-wrapped vl or an explicit :443 port | draft (2026-10-01) |

## Recently closed

| Plan | Title | Status |
|---|---|---|
| [0017](done/0017-conductor-followups-queue-hygiene.md) | Conductor followups: a loud Blocks-merge parse, a clean prune, ready vs the working copy | done (2026-10-01): built as planned, one nit and one conductor followup open, no version bump |
| [0018](done/0018-latin-note-after-link-and-check-gaps.md) | A Latin note after a receipt link, the caps-dropped screen test, and a link checker that reads only tracked docs | done (2026-10-01): built as planned, no findings, v0.9.2 |
| [0016](done/0016-close-findings-receipts-budgets-groups.md) | Close findings: receipt backoff, links with a note, group dates, caps currency, budget navigation | done (2026-10-01): built as planned, three nits open as followups, v0.9.1 |
| [0014](done/0014-fiscal-receipts-rs-me.md) | Fiscal receipts: a QR photo or link from Serbia or Montenegro becomes an expense with its line items | done (2026-10-01): built as planned, three minors and one nit open, Phase 7 real-receipts check owed, v0.9.0 |
| [0011](done/0011-budgets.md) | Budgets: a payday-period limit, a daily allowance, essential categories and category caps | done (2026-10-01): built as planned, two minors and two nits open, Phase 6 live check owed, v0.8.0 |
| [0009](done/0009-group-ledgers.md) | Group ledgers: the bot as a group's accountant, with personal books kept private | done (2026-10-01): built as planned, one minor open, Phase 5 live check owed, v0.7.0 |
| [0010](done/0010-conductor-followups-readiness-at-queue-time.md) | Conductor followups: readiness at queue time, main before readiness, resume and idle fixes | done (2026-10-01): built as planned, two conductor followups logged, no version bump |
| [0004](done/0004-dates-edit-summaries.md) | Past dates, /week and /month by category, and the edit flow | done (2026-09-30): built as planned after one fix round, `/help` copy owed, v0.6.0 |
| [0008](done/0008-version-announcements.md) | Version announcements: tell the admin about each new version, and /changelog | done (2026-09-30): built as planned after one docs fix round, v0.5.0 |
| [0005](done/0005-settings.md) | /settings: timezone from a city list, and the ledger's default currency | done (2026-09-30): built as planned, one minor open, v0.4.0 |
| [0002](done/0002-deploy-docker-vps.md) | Deploy: Docker Compose on the shared VPS, CI gate, daily SQLite backups | done (2026-09-30): built as planned, prod shares the dev bot token, no version bump |
| [0006](done/0006-conductor-trial.md) | Conductor trial: fork Ritmolux's conductor, run Plans 0007 and 0003 unattended | done (2026-09-30): built as planned, trial verdict go, no version bump |
| [0003](done/0003-categories.md) | Categories: preset per ledger, suggestion from history, change and manage | done (2026-09-30): built as planned after one fix round, `/help` copy owed, v0.3.0 |
| [0007](done/0007-navigation-shell.md) | Navigation shell: menu, HTML seam, callback dispatcher, and the shipped-UX fixes | done (2026-09-30): built as planned, v0.2.0 |
| [0001](done/0001-scaffold-walking-skeleton.md) | Scaffold and walking skeleton: record "450 coffee", see it in /today | done (2026-09-29): built as planned, v0.1.0 |
