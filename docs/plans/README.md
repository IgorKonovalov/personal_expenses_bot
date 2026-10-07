# Plans

Phased implementation plans written by the `architect` skill and implemented by `dev`. A plan is
`NNNN-<slug>.md`. It moves to `done/` at its close ceremony. **Rows are pointers:** link, title,
status and date. What a plan did lives in the plan.

- **Next free number:** `0040`

## Active

| Plan | Title | Status |
|---|---|---|
| [0033](0033-qr-retry-variant-sweep.md) | A committed sweep for more receipt QR retry variants | approved (2026-10-05) |

## Recently closed

| Plan | Title | Status |
|---|---|---|
| [0037](done/0037-category-drill-down.md) | Category drill-down: from /week or /month to a category's expenses, and on to each expense's card | done (2026-10-07): built as planned, one nit fixed at close, one minor open, Phase 4 live check owed, v0.29.0 |
| [0039](done/0039-scale-hardening.md) | Scale hardening: no update waits behind a photo, pushes survive the 1st, backups fit the disk | done (2026-10-07): built as planned after one docs fix pass, one nit fixed at close, one nit open, Phase 7 live checks owed, v0.28.0 |
| [0038](done/0038-prices-view-cost.md) | /prices stops re-matching every receipt item on every tap | done (2026-10-07): built as planned, one minor fixed at close, Phase 4 live check owed, v0.27.1 |
| [0030](done/0030-mini-app-charts-and-qr-scan.md) | Charts in the Mini App, static with no backend | done (2026-10-07): built as planned, one minor and one nit fixed at close, two nits open, Phases 2 publish and 4 live check owed, v0.27.0 |
| [0036](done/0036-product-prices-across-months.md) | Product prices across months: receipt items grouped into products, with spend, amount and unit price per month | done (2026-10-07): built as planned, one minor and one nit fixed at close, two minors open, Phase 6 real receipts owed, v0.26.0 |
| [0032](done/0032-live-qr-scan-mini-app.md) | A live QR scan in a Mini App records a receipt | done (2026-10-07): built as planned, three minors open, Phase 2 publish and real scan owed, v0.25.0 |
| [0026](done/0026-monthly-summary-push.md) | Monthly summary push: last period's report arrives on its own | done (2026-10-06): built as planned, one minor and one nit open, Phase 5 real month owed, v0.24.0 |
| [0035](done/0035-collapsed-lists-period-items-tidy-chat.md) | Collapsed lists, receipt items by category for a day, week or month, and an opt-in tidy chat | done (2026-10-06): built as planned, one minor and one nit fixed at close, one nit open, Phase 6 live check owed, v0.23.0 |
| [0015](done/0015-onboarding.md) | Onboarding: confirm the setup on first contact, then teach each feature when it becomes relevant | done (2026-10-06): built as planned after one fix pass, two followups open, Phase 5 day one passed, next-day tipForeign owed, v0.22.0 |
| [0034](done/0034-pre-invite-polish.md) | Pre-invite polish: every command on a button, a full command menu, a clean receipt chat, and notices shown once | done (2026-10-06): built as planned, one minor fixed at close, one minor open, Phase 5 live check passed, v0.21.0 |
| [0012](done/0012-tags-projects.md) | Tags for projects: `#отпуск` on an expense, and a report per tag | done (2026-10-06): built as planned, one minor fixed at close, five minors and three nits open, Phase 6 real trip owed, v0.20.0 |
| [0013](done/0013-debts.md) | Debts: who owes whom, closed in the currency they were opened in | done (2026-10-06): built as planned after one fix pass, four minors and two nits open, Phase 6 real debts and group owed, v0.19.0 |
| [0027](done/0027-bank-statement-import.md) | Bank statement import: a Serbian bank's export file becomes expenses | done (2026-10-06): built as planned, two minors open, Phase 5 real statement owed, v0.18.0 |
| [0025](done/0025-recurring-expenses-and-reminders.md) | Recurring expenses and reminders: rent and subscriptions recorded on their day | done (2026-10-06): built as planned after one fix pass, one minor fixed at close, one nit open, Phase 7 real month owed, v0.17.0 |
| [0029](done/0029-opening-by-invite.md) | Opening by invite: invite links, abuse limits, a privacy policy and account deletion | done (2026-10-06): built as planned after one fix pass, one minor fixed at close, Phase 7 deploy and open owed, v0.16.0 |
| [0024](done/0024-export-and-data-ownership.md) | Export and data ownership: every expense out as CSV or XLSX, free | done (2026-10-03): built as planned, one minor and two nits open, Phase 5 real-apps check owed, v0.15.0 |
| [0028](done/0028-donations.md) | Donations: everything free, `/donate` via Telegram Stars and an external link | done (2026-10-06): built as planned, two minors open, Phase 4 live donation and refund owed, v0.14.0 |
| [0031](done/0031-receipt-photo-qr-retry-passes.md) | Receipt photos that fail the plain QR pass get retried on preprocessed pixels | done (2026-10-05): built as planned after two fix passes, one minor and one nit open, Phase 5 live check owed, v0.13.0 |
| [0019](done/0019-encrypted-personal-ledger.md) | Encrypted personal ledger: recording stays open, reading needs the owner's passphrase | done (2026-10-02): built as planned after three fix passes, one minor open, Phase 6 live check owed, v0.12.0 |
| [0023](done/0023-fx-fetch-expense-days-newest-first.md) | The rate worker fetches only expense days, newest first | done (2026-10-01): built as planned, one nit open, Phase 2 live check owed, v0.11.1 |
| [0022](done/0022-converted-totals-nbs.md) | Totals and budgets converted into one currency at the NBS rate | done (2026-10-01): built as planned, three nits open, Phase 4 live check owed, v0.11.0 |
| [0021](done/0021-bank-sms-card-purchase.md) | A pasted Serbian card-purchase SMS records the purchase | done (2026-10-01): built as planned, no findings, Phase 3 real-SMS check passed, v0.10.0 |
| [0020](done/0020-receipt-urls-wrapped-vl-and-port.md) | Receipt links with a line-wrapped vl or an explicit :443 port | done (2026-10-01): built as planned, one nit open, Phase 2 real-receipts check passed, v0.9.3 |
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
