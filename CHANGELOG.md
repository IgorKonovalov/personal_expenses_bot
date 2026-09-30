# Changelog

Versions follow semver. There's one entry per closed plan, and the plan holds the detail.

## 0.3.0 (2026-09-30)

From Plan 0003 (categories).

- Every new expense gets a category, shown at the end of the confirmation. It comes from what
  you chose before for the same description, then from keywords, then «Другое».
- [Категория] under a confirmation opens a paged picker. The choice is remembered for next time.
- `/categories` adds, renames and hides categories in each ledger. `/cancel` stops a pending
  question.

## 0.2.0 (2026-09-30)

From Plan 0007 (navigation shell).

- A persistent menu bar, `[📊 Сегодня] [❓ Помощь]`, and a `/help` command. Edited messages,
  photos, stickers and unknown commands get an answer instead of silence.
- Messages are sent as escaped HTML, with amounts in bold.
- The confirmation's button is now [Удалить], and a deleted expense comes back with [Вернуть].
- An ambiguous amount such as `1.200 обед` is answered with one button per reading, so there is
  no need to type it again.

## 0.1.0 (2026-09-29)

First release, from Plan 0001 (scaffold and walking skeleton).

- Send an expense as free text (`450 кофе`, `12,50 EUR такси`). It's recorded in your personal
  ledger with an Undo button. Ambiguous amounts such as `1.200` are asked about, never guessed.
- `/today` shows today's totals per currency, in your timezone.
- Access is limited to the Telegram ids in `ALLOWED_TELEGRAM_IDS`.
- SQLite storage with forward-only migrations. `pnpm dev` loads `.env`.
