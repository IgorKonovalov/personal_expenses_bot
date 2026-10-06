# Changelog

Versions follow semver. There's one entry per closed plan, and the plan holds the detail.

## 0.17.0 (2026-10-06)

From Plan 0025 (recurring expenses and reminders).

- [Повторять] under the author's expense card makes a rule from it: every month on its day,
  every week on its weekday, or every year on its date. Each occurrence is recorded at 09:00 in
  the ledger's timezone, with [Удалить] on its notice. Days 29 to 31 fall on a short month's
  last day.
- A rule can ask first instead, with [Записать] / [Другая сумма] / [Пропустить], for bills that
  vary. /recurring lists the rules, switches their mode, deletes them, and adds reminders that
  just send a text on their day.
- Group expenses repeat into their group, and only the author can act on them. Rules in a sealed
  ledger record without the passphrase, and their notices carry no amount or description.
- After downtime, missed expenses are recorded on their own dates, once; a reminder sends only
  its latest missed date. /delete_account also removes the user's rules and reminders.

## 0.16.0 (2026-10-06)

From Plan 0029 (opening by invite).

- Admission moves from `.env` into the database. The admin's /invite makes a `t.me` link that
  admits a set number of people within a set number of days; /invites lists and revokes them.
  Anyone else gets one «работает по приглашениям» reply, then silence.
- Admin-only /block, /unblock and /stats. A per-user message rate limit and a daily cap of 20
  receipts guard against abuse.
- /privacy summarises the new `PRIVACY.md` policy, and /delete_account removes the personal
  ledger and its data; group expenses stay, shown as «удалённый участник».
- Env: `ALLOWED_TELEGRAM_IDS` is replaced by `ADMIN_TELEGRAM_ID` (required) and
  `ADMIT_TELEGRAM_IDS` (optional); a set `ALLOWED_TELEGRAM_IDS` fails the boot.

## 0.15.0 (2026-10-06)

From Plan 0024 (export and data ownership).

- /export, in the private chat and in a bound group, picks a period (this month, last month,
  this year, all time) and a format, then sends the expenses as a file: CSV (plus a second CSV
  of receipt items, as one album) or an Excel workbook with a receipt-items sheet.
- Each row carries the date and time, the amount and currency as recorded, the amount in the
  ledger's currency at the NBS rate, the category, the description, the author in a shared
  ledger, and the shop and link for a receipt. Export is free.
- A sealed ledger exports only while unlocked, and the picker says the file is an unencrypted
  copy.

## 0.14.0 (2026-10-06)

From Plan 0028 (donations).

- The bot stays free and says so. /donate in a private chat offers 50, 150 or 500 Telegram Stars,
  each opening the payment sheet directly, plus an external page when `DONATE_URL` is set. A
  donation unlocks nothing. The donor gets one thank-you and the admin one notice.
- The private /help ends with a line pointing to /donate.
- /paysupport <text> relays a refund request to the admin, and the admin's /refund <charge id>
  returns the Stars.

## 0.13.0 (2026-10-05)

From Plan 0031 (receipt photo QR retry passes).

- A receipt photo whose QR code doesn't read on the first try is retried on preprocessed pixels
  (blurred and thresholded), so a pale or smudged thermal-print QR can still record the expense.
- When nothing reads, the hint says whether the QR code was found at all: get closer when it
  wasn't, shoot flat, in focus and without glare when it was. Neither suggests sending a file.

## 0.12.0 (2026-10-02)

From Plan 0019 (encrypted personal ledger).

- /settings -> [Шифрование] encrypts the personal ledger under a passphrase and shows a one-time
  recovery code. Expenses still record as before, but /today, /week, /month, /budget and the
  expense cards need /unlock and the passphrase. The ledger relocks after 30 minutes without a
  read, on /lock and on every restart. /recover takes the code and sets a new passphrase.
- Messages carrying the passphrase or the code are deleted from the chat. A sealed ledger takes
  no receipt QR codes and suggests categories from keywords only.
- Existing databases rebuild the expenses table once at boot.

## 0.11.1 (2026-10-01)

From Plan 0023 (fx fetch of expense days, newest first).

- After an update, the NBS rates load first for the most recent days with an expense, so this
  week's and this month's totals convert right away instead of hours later. Days with no expense
  are no longer fetched.

## 0.11.0 (2026-10-01)

From Plan 0022 (converted totals at the NBS rate).

- /today, /week and /month, in the private chat and in groups, show one total in the ledger's
  currency. A foreign expense converts at the National Bank of Serbia middle rate of its day, the
  total is marked `≈`, and a note names what was converted. A currency NBS doesn't list (KZT,
  among others) stays in its own block. Group members' totals are converted too.
- Budgets count foreign spending converted into the budget's currency, so the figure under each
  expense and the category caps include it. Spending with no rate is listed as `Не учтено, нет
  курса`.

## 0.10.0 (2026-10-01)

From Plan 0021 (bank SMS card purchase).

- A Serbian card-purchase SMS (`Koriscenje kartice`) pasted or forwarded into the private chat
  records one expense in the charged currency, dated the purchase day, described by the merchant.
  The same SMS sent again answers «Уже записано». An SMS the bot can't read, in an unknown
  currency or dated in the future is refused, and nothing is recorded.

## 0.9.3 (2026-10-01)

From Plan 0020 (receipt links with a wrapped vl or :443).

- A Serbian receipt whose QR link wraps its data across lines, or names the host with `:443`,
  is read as a receipt instead of being refused or ignored. A Montenegrin link with `:443` is too.

## 0.9.2 (2026-10-01)

From Plan 0018 (close nits of Plan 0016).

- A receipt link followed by a note in Latin letters, such as `<link> kafa`, is read as an
  expense, not refused as a broken link.

## 0.9.1 (2026-10-01)

From Plan 0016 (close findings of Plans 0003, 0009, 0011 and 0014).

- A receipt whose fetched details fail to save backs off like any other failed fetch, instead of
  being refetched from the tax site every few seconds.
- A receipt link with a note after it, such as `<link> кофе`, is read as an expense, not refused
  as a broken link.
- A group expense opened in DM shows and edits its date in the group's timezone.
- Setting a budget limit after changing the ledger's currency drops the category caps, and the
  budget screen says so.
- The budget screen opened from settings has [« Назад], and the category cap prompt has
  [« Назад] to the cap list. The group `/budget` no longer asks the group to re-set the limit.
- `/help` mentions `/cancel`.

## 0.9.0 (2026-10-01)

From Plan 0014 (fiscal receipts from Serbia and Montenegro).

- In DM, a photo or image file of a Serbian or Montenegrin fiscal receipt, or its pasted
  verification link, records one expense with the receipt's total in RSD or EUR. It's dated the
  receipt's day in the user's timezone. Sending the same receipt again answers «Уже записано.»
  with the existing card.
- A few seconds later the card gains the shop's name and the item count. [Позиции] lists the line
  items, and [Повторить] retries when the tax site didn't answer.
- The bot now calls `suf.purs.gov.rs` and `mapr.tax.gov.me` for receipt details. New dependency:
  `zxing-wasm` for reading QR codes.
- `/help` mentions receipts, past dates and the card's edit buttons.

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
