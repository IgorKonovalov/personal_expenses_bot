# Changelog

Versions follow semver. There's one entry per closed plan, and the plan holds the detail.

## 0.8.0 (2026-10-01)

From Plan 0011 (budgets).

- `/budget` and the menu's [💰 Бюджет] set a spending limit for a period. Once it's set, every
  expense card says what's left for today and until the period's end. The daily figure is
  cumulative, so yesterday's leftover or overspend carries into today.
- The period can start on any day of the month (payday) with [День начала периода].
- [Обязательные] on `/categories` marks the essential categories, and the budget can count only
  optional spending. [Лимиты по категориям] caps single categories for the period, and a capped
  category's card gets its own line.
- Spending in another currency isn't counted, and the `/budget` screen lists it separately.
- A group ledger's owner sets its budget from the group's `/settings` hub. `/budget` in the group
  shows it, and group reactions stay quiet.

## 0.7.0 (2026-10-01)

From Plan 0009 (group ledgers).

- An allowed user adds the bot to a Telegram group, and the group gets its own shared ledger.
  Any member writes `450 кафе` there, and it's recorded in the group's ledger under their name.
  Personal expenses in DM stay private and never appear in the group.
- A recognised expense gets a ✍ reaction. One that falls to «Другое» gets a card with
  [Удалить], and [Изменить в личке] for allowed users. Only the author can delete or edit.
  Replying `/card` to a recorded message shows its card.
- `/today`, `/week` and `/month` in the group show the group's spending by category and by
  person, in the group ledger's timezone.
- The group owner's `/settings` links to a DM screen for the group ledger's timezone and
  currency. Removing the bot keeps the ledger, and adding it back resumes it.

## 0.6.0 (2026-09-30)

From Plan 0004 (past dates, summaries by category, and the edit flow).

- A date as the last word records the expense on that day: `450 такси вчера`, `позавчера`,
  `25.09` (the most recent such date) or `25.09.2025`. The confirmation names the date when it
  isn't today. A future full date records nothing.
- `/week` (Monday to Sunday) and `/month` show, per currency, a total and then the categories by
  amount. [◀ Август] [Октябрь ▶] page to the neighbouring period in the same message. The menu's
  first row is now `[📊 Сегодня] [📅 Неделя] [🗓 Месяц]`.
- [Изменить] under a confirmation changes the amount, the description or the date, with
  [Сегодня] [Вчера] [Позавчера] for the date.

## 0.5.0 (2026-09-30)

From Plan 0008 (version announcements).

- On a boot with a version it hasn't announced yet, the bot sends the admin (the first id in
  `ALLOWED_TELEGRAM_IDS`) a short «🆕 Версия X.Y.Z» note. A restart on the same version sends
  nothing.
- `/changelog` shows every allowed user what changed, one entry per version, newest first.

## 0.4.0 (2026-09-30)

From Plan 0005 (settings).

- `/settings` and the `⚙️ Настройки` menu button open the settings: your timezone and the
  ledger's default currency, each changeable in place, and a link to the categories.
- The timezone comes from a list of cities, or [Другой…] takes any IANA name such as
  `Europe/Istanbul`. "Today" follows the chosen zone; recorded expenses keep their date.
- The ledger owner picks the currency for new expenses. Recorded expenses keep theirs.
- The menu's second row is now `[⚙️ Настройки] [❓ Помощь]`.

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
