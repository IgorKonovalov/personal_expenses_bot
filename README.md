# Personal Expenses Bot

A Telegram bot for recording and summarising personal and family expenses. You send a line like
`450 кофе` and it's recorded in your active ledger, in the ledger's currency and on your local
date. `/today` shows today's totals. The bot speaks Russian.

It's built for one household spread across countries and currencies (RSD, EUR, RUB, KZT, …). So
money is exact integer minor units, every user has their own timezone, and nothing is guessed
when an amount could be read two ways.

> **Status:** in daily use by one household, deployed on a VPS. The running version is in
> `package.json` and `/changelog` says what each one brought. See [Roadmap](#roadmap) for what's
> next.

## Using the bot

| You send                             | The bot does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/start`                             | Creates your account and a personal ledger («Личные расходы»), then sends the welcome and a setup check: your timezone with your local time, and the default currency, with [Да, всё верно] and [Изменить] (the `/settings` hub). If your first message is something else, it's handled as usual and the welcome and the check follow. Sent again, `/start` replays the welcome and the check, and starts the tips over with tips switched on                                                                                                                                                                                                                                                                                                    |
| `450 кофе`                           | Records 450.00 in the ledger's default currency, in a category picked from how this ledger filed `кофе` before, else by keyword, else «Другое». Replies `Записано в «Личные расходы»: 450.00 RSD — кофе · Кафе и рестораны` with [Категория], [Изменить] and [Удалить]                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `450 такси вчера`, `450 такси 25.09` | Records the expense on a past date. Only the last word is read as a date: `вчера`, `позавчера`, `dd.mm` (the most recent such date, today included) or `dd.mm.yyyy`. A future `dd.mm.yyyy` records nothing. The confirmation names the date when it isn't today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [Категория]                          | Opens a paged list of the ledger's categories in the same message. A tap moves the expense there, and the next expense with the same description follows it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [Изменить]                           | Offers [Сумма], [Описание] and [Дата] in the same message. The card then asks for the new value as your next message (the date prompt also has [Сегодня] [Вчера] [Позавчера]). [Отмена] puts the card back unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `12,50 EUR такси`                    | Records 12.50 EUR. A currency code after the amount overrides the default (case-insensitive)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `1 200 обед`                         | Records 1 200.00. Group thousands with a space                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `1.200 обед`                         | Records **nothing** and replies to your message with one button per reading ([1 200.00 RSD] [1.20 RSD]). A tap records that reading. A second tap records nothing more                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/today`                             | `Сегодня, 30 сентября — «Личные расходы»`, then the day's total in the ledger's currency, foreign amounts converted (`≈`, see [Currency conversion](#currency-conversion)). [Позиции], shown when the day's receipts list items, lists them by category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/week`, `/month`                    | This week (Monday to Sunday) or calendar month: one total in the ledger's currency, then its categories by amount folded under it (a tap opens them), foreign amounts converted. [◀ Август] [Октябрь ▶] page to the neighbouring period in the same message. [Позиции] lists the period's receipt items by category, sorted by name, with a pager and [« Назад]                                                                                                                                                                                                                                                                                                                                                                                  |
| [Удалить]                            | Soft-deletes that expense and turns the confirmation into a deleted card with [Вернуть]. A second tap says it's already deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [Вернуть]                            | Restores the expense, and `/today` counts it again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/categories`                        | Lists the ledger's categories, with [Добавить], [Переименовать] and [Скрыть]. Adding and renaming ask for the name as your next message. Adding a hidden category's name brings it back. [Обязательные] marks which categories are essential (rent, groceries)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/budget`                            | The ledger's budget: the limit, the period with its day number, what's left for today and for the period, with spending in other currencies converted into the budget's currency, and any spending with no rate listed as not counted. [Задать лимит] sets the limit for a period, [День начала периода] moves the period start to your payday (1 to 31), [Считать все] / [Только необязательные] picks whether essential categories count, and [Лимиты по категориям] caps single categories. Once set, every expense card gains `Осталось на сегодня: 517.74 RSD · до 31 окт: 29 550.00 RSD`, and a capped category's line `Кафе и рестораны: 450.00 из 5 000.00 RSD`. Yesterday's leftover or overspend carries into today                    |
| `/settings`                          | Shows your timezone and the ledger's default currency, with [Часовой пояс], [Валюта], [Категории], [Шифрование] (see [Encrypted ledger](#encrypted-ledger)), [Итоги месяца: вкл/выкл] and [Итоги недели: вкл/выкл] (see [Summary pushes](#summary-pushes)), [Подсказки: вкл/выкл] and [Убирать мои сообщения: вкл/выкл], which deletes your message once it has recorded an expense. The timezone comes from a list of cities or, via [Другой…], any IANA name you type (`Europe/Istanbul`). Past expenses keep their date                                                                                                                                                                                                                       |
| [Повторять], `/recurring`            | [Повторять] on your expense's card offers «Каждый месяц, 15-го», «Каждую неделю, по средам» and «Каждый год, 15.10», from the expense's date. On each due day at 09:00 in the ledger's timezone the bot records the same expense and posts it with [Удалить]; missed days after downtime are recorded on their own dates, once. `/recurring` lists the rules: [Спрашивать перед записью] makes one ask first with [Записать] / [Другая сумма] / [Пропустить], [Удалить правило] stops it (recorded expenses stay), and [Добавить напоминание] sends a text on its day. A group expense repeats into its group. In a sealed ledger the rule is sealed too, and its notice names neither amount nor description; a reminder's text stays plaintext |
| `/debts`                             | Who owes you and whom you owe, one line per person and currency: `Петя — должен вам 5 000.00 RSD`. [Я дал в долг] / [Я взял в долг] ask for the amount, then the person (a button per known person, or a typed name; «петя» reuses Петя). A person's button opens their card with the last 10 operations and [Мне вернули] / [Я вернул]; a repayment is in the debt's own currency, at most the balance, or [Весь долг]. [Удалить] under a confirmation removes that operation. Nothing is converted, and debts never count as spending. In a sealed ledger names and amounts are sealed too, and `/debts` opens only while unlocked                                                                                                             |
| `1000 кафе /3`                       | Records your share (333.34 RSD, the remainder is yours) and asks which two people owe you 333.33 RSD each: toggle known people or type a name, then [Готово], or [Пропустить] to record no debts. `/N` takes 2 to 20. In a sealed ledger that is locked the share is recorded and the bot asks you to add the debts from `/debts` after `/unlock`                                                                                                                                                                                                                                                                                                                                                                                                |
| `450 кофе #отпуск #рим`              | Records the expense with tags: `#words` leave the description, up to 5 per expense. [Изменить] → [Метки] replaces them, `-` clears them. In a sealed ledger tags are sealed with the rest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/tags`                              | The ledger's tags with their all-time totals in the ledger currency, most recently used first; a tag's button shows its total by category, its expense count and its first and last date. In a group, the group ledger's tags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/tag отпуск`                        | Adds `#отпуск` to every expense you record into the active ledger (in a group, the group's) until [Снять метку]; in private, `/tag` alone shows it. In a sealed ledger it lasts until the bot restarts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/prices`                            | The products you buy («Молоко», «Хлеб», «Бананы»), built from the items of your own fetched receipts in the active ledger and ordered by spend over the last 12 months. A product shows each month's spend, the amount bought and the price per litre, kilogram or piece, plus the all-time totals. [Разобрать] walks the item names no rule recognised, [Названия] corrects which names count under a product, and [Новый продукт] adds your own. In a sealed ledger only the built-in rules apply, and the list opens only while unlocked                                                                                                                                                                                                      |
| `/cancel`                            | Drops a pending question (like the new category's name) and puts the list or the expense card back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/export`                            | Asks for a period («Этот месяц», «Прошлый месяц», «Этот год», «Всё время») and a format, then sends the active ledger's expenses as a file: [CSV] (UTF-8, `;`, decimal comma; receipt items as a second file) or [Excel] (an `.xlsx` with a second sheet for receipt items). Every row has the date, time, amount and currency, the amount in the ledger's currency at the NBS rate, the category, the description, the tags, the shop and receipt link, and the expense ID. Free, any time. A sealed ledger exports only while unlocked, and the file is a plaintext copy                                                                                                                                                                       |
| `/help`                              | How to record an expense, and what the menu buttons do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/changelog`                         | What's new: the five newest versions, then a link to CHANGELOG.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/privacy`                           | A three-line summary of what is stored and who sees it, and a link to [PRIVACY.md](PRIVACY.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/delete_account`                    | Says what goes (the personal ledger with every expense, receipt, category and budget, and your settings) and what stays (your expenses in group ledgers, shown as «удалённый участник», and backups for up to `max(BACKUP_KEEP, 7 × BACKUP_KEEP_WEEKLY)` days, 28 by default), with [Удалить всё] / [Отмена]. After deleting, the same Telegram account needs a new invite                                                                                                                                                                                                                                                                                                                                                                       |
| `/donate`                            | The bot is free and a donation unlocks nothing. Offers [⭐ 50] [⭐ 150] [⭐ 500], each opening Telegram's Stars payment sheet, and [Ko-fi] when `DONATE_URL` is set. See [Donations](#donations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/paysupport`                        | Says a donation unlocks nothing. `/paysupport <текст>` relays a refund request to the admin, with your internal user id and your newest donations. See [Donations](#donations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`/start` and `/help` show a persistent menu bar under the input field: [📊 Сегодня] answers like
`/today`, [📅 Неделя] like `/week`, [🗓 Месяц] like `/month`, [💰 Бюджет] like `/budget`, [⚙️ Настройки] like `/settings`, and [❓ Помощь] like `/help`. [☰ Ещё] opens one button for every other command: [Регулярные], [Долги], [Метки], [Включить метку], [Цены], [Экспорт], [Что нового], [Поддержать], [Возврат пожертвования], [Приватность] and [Удалить аккаунт], plus [Открыть учёт] or [Закрыть учёт] for a sealed ledger. Each answers exactly like its command. [Включить метку] and [Возврат пожертвования] first ask for the tag or the request, with [Отмена], and then answer like `/tag <ответ>` or `/paysupport <ответ>`. The admin also gets [Пригласить], [Приглашения], [Статистика], [Заблокировать], [Разблокировать] and [Вернуть Stars]; the last three ask for the Telegram id or the charge id the same way. The `/` menu in a private chat lists every command, and the admin's chat adds the admin commands. Only the exact label is a menu tap. A menu tap or any
command also drops a pending question, which otherwise expires after 10 minutes. Unknown commands,
text that isn't an expense, stickers, voice messages and files that aren't images get the full
help the first time, and afterwards one line pointing to [❓ Помощь] that deletes itself after a
minute ([ADR-0037](docs/adrs/0037-first-time-notices-and-transient-replies.md)). Photos are read
for a receipt QR code (see Receipts below). Editing a sent expense doesn't change the record, and
the bot says so the first time. A sealed ledger's warnings (the export file is a plaintext copy,
a reminder's text is stored plaintext) are likewise shown on the first prompt only.

Once you're onboarded, a reply is sometimes followed by a tip about a feature you haven't used
yet: at most one a day, each tip once, in a private chat only. [Отключить подсказки] under any tip
switches them off, and [Подсказки: вкл/выкл] in `/settings` switches them back on.

### Summary pushes

The morning after a period closes, at 09:00 in your timezone, the bot sends the personal
ledger's report without being asked: «Итоги сентября» on 1 October. With a budget whose period
starts on your payday, it is the budget period instead, «Итоги периода 15.09–14.10», sent on the
day after it ends. The report has the total and each category with its change against the period
before («Кафе и рестораны: 12 400.00 RSD (+3 100.00, +33%)», or «новое»), the top 10 categories
with the rest on one line, how the budget's limit ended («осталось» or «перерасход»), the three
largest expenses, and a `/donate` line. Currencies with no rate stay on their own lines, with no
change shown.

It is on by default. [Отключить] under a push, or [Итоги месяца: вкл/выкл] in `/settings`,
switches it off. [Итоги недели: вкл/выкл] adds a Monday push for last week, with the total and
the categories only. Each push goes out once. A period with no expenses sends nothing, and a
push more than 7 days late (after downtime) is skipped. Groups get no push. For a sealed ledger
that is locked, the push says only «Итоги сентября готовы», and [Показать] shows the report in
place after `/unlock`.

### Joining

The bot works by invitation ([ADR-0024](docs/adrs/0024-admission-lives-in-the-database-via-invite-codes.md)).
The admin (`ADMIN_TELEGRAM_ID`) sends `/invite` and gets a link `https://t.me/<bot>?start=<code>`
that admits up to 10 people within 14 days; `/invite 30 7` makes one for 30 people and 7 days
(each number from 1 to 1000). Opening the link starts the bot as a normal `/start`. A link that is
used up, expired or switched off answers «Ссылка недействительна или истекла». Anyone else gets
one «Бот работает по приглашениям» reply and then silence. `ADMIT_TELEGRAM_IDS` admits the listed
ids at boot, without a link.

Admin-only commands (anyone else gets the `/help` answer):

| Admin sends            | The bot does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `/invite [uses days]`  | Makes an invite link                                                                               |
| `/invites`             | Lists the live links with `used/max` and the expiry date, each with [Отключить] to switch it off   |
| `/block <telegram id>` | Drops every update from that account, in private and in groups; `/unblock <telegram id>` undoes it |
| `/stats`               | Admitted users, users and expenses of the last 7 days, live links. Counts only, no amounts         |

Limits for everyone but the admin: at most 30 updates per minute (the rest are dropped silently),
and 20 receipts per local day («Лимит чеков на сегодня исчерпан, попробуйте завтра»). On a boot
with a new version, the bot sends the admin a short «🆕 Версия X.Y.Z» note (ADR-0013).

### In a group

The bot can keep a group's shared books, such as a family's, next to everyone's private ones
([ADR-0014](docs/adrs/0014-group-chats-bind-to-shared-ledgers.md)).

1. In [@BotFather](https://t.me/BotFather), set `/setjoingroups` to Enabled and `/setprivacy` to
   Disabled, so the bot reads ordinary group messages. A privacy change applies only to groups
   the bot joins afterwards, so remove the bot from a group and add it again after changing it.
2. An admitted user adds the bot to the group. The group gets its own shared ledger, named
   after the group, in that user's currency and timezone. Added by anyone else, the bot leaves.

| In the group                | The bot does                                                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `450 кафе` from any member  | Records it in the group ledger under the sender's name, dated in the ledger's timezone. A recognised category gets a ✍ reaction; «Другое» gets a reply card with [Удалить]                                                                                            |
| [Удалить], [Вернуть]        | Work for the expense's author only. [Изменить в личке] on the card opens it in the author's private chat (admitted authors only)                                                                                                                                       |
| `/card` as a reply          | Shows the card of the expense that message recorded                                                                                                                                                                                                                    |
| `/today`, `/week`, `/month` | The group ledger's totals, by category and by person, one total in the group ledger's currency, foreign amounts converted. The pager works for anyone in the group                                                                                                     |
| `/settings`                 | For the person who added the bot: a link to the group ledger's timezone and currency in the private chat, where [Бюджет] sets the group ledger's budget. Your own timezone doesn't change. Anyone else gets a one-line refusal                                         |
| `/budget`                   | The group ledger's budget, read-only: what's left for today and for the period, in the ledger's timezone. Expense reactions carry no budget line                                                                                                                       |
| `/export`                   | Any member: the group ledger's expenses as a CSV or Excel file sent to the group, like `/export` in private, with an «Автор» column naming who recorded each one                                                                                                       |
| `/settle`                   | Splits every group expense equally among the members who had joined by its date, per currency, and lists the fewest transfers that square it. [Перевёл] (payer or receiver only) records a transfer; [Я тоже участвую] joins a member who hasn't recorded anything yet |
| `/tags`                     | The group ledger's tags with their totals, and a tag's report by category, like `/tags` in private                                                                                                                                                                     |
| `/tag отпуск`               | Tags every expense you record in the group until [Снять метку]; the sticky tag is yours alone, other members' expenses don't get it. `/tag` with no argument answers the usage                                                                                         |
| `/help`                     | The group's help text                                                                                                                                                                                                                                                  |

Other chatter, stickers and other bots' commands get no reply. Expenses you send the bot in
private stay in your personal ledger and never appear in the group. Removing the bot keeps the
ledger; adding it back (an admitted user) picks the same ledger up again.

### Receipts

In a private chat, a Serbian or Montenegrin fiscal receipt becomes one expense
([ADR-0018](docs/adrs/0018-receipts-record-offline-enrich-async.md)). Send a photo of its QR
code, the photo as a file, or the link the QR code holds (`https://suf.purs.gov.rs/v/?vl=…` or
`https://mapr.tax.gov.me/ic/#/verify?…`).

- The bot reads the total, the date and the receipt's fiscal id from the QR code alone, offline,
  and records the total in RSD or EUR, dated the receipt's day in your timezone. The card reads
  `… — Чек` at first.
- Within a few seconds the bot fetches the shop and the line items from the tax authority's
  site. The card then names the shop and shows its items folded under `Магазин · 12 позиций`
  (a tap opens them). A list too long for one message stays behind [Позиции], which lists the
  items in the same message. If the site stays unreachable (6 attempts over about
  14.5 hours), the card says so and offers [Повторить]. The expense keeps the QR total either way.
- The same receipt sent again, as a photo or as a link, records nothing and answers «Уже
  записано» with the existing card. Refunds, copies, pro-forma and advance invoices are refused.
- Once its card is sent, a recorded or already recorded receipt's photo (or image file) is
  deleted from the chat: the card carries everything it said. A photo the bot couldn't read, or
  whose receipt it refused, stays. A pasted link is never deleted.
- QR codes are decoded with [zxing-wasm](https://github.com/Sec-ant/zxing-wasm), loaded from
  `node_modules` ([ADR-0019](docs/adrs/0019-qr-decoding-zxing-wasm.md)). A JPEG that doesn't
  decode is retried on preprocessed pixels
  ([ADR-0034](docs/adrs/0034-qr-retry-on-preprocessed-pixels-jpeg-js.md)). If that fails too, the
  bot says whether it found the code at all and how to retake the photo, or to paste the link.

Besides Telegram, these are the only hosts the bot connects to, and only to fetch a receipt's
shop and items:

- `suf.purs.gov.rs` (Serbia): the verify URL as JSON and as HTML, and `POST /specifications`
- `mapr.tax.gov.me` (Montenegro): `POST /ic/api/verifyInvoice`

Groups ignore photos and receipt links.

### Bank SMS

In a private chat, paste or forward a card-purchase SMS from your bank and it becomes one expense
([ADR-0021](docs/adrs/0021-bank-sms-template-parsers-plain-expense.md)). One template is read so
far: the Serbian `Koriscenje kartice` / `Korišćenje kartice` SMS, with its `Datum:`, `Iznos:` and
`Mesto:` lines. Other banks' SMS still get the `/help` answer.

- The amount comes from `Iznos:` only, never the balance line, and is stored in the charged
  currency: a USD charge on an RSD card is recorded in USD.
- `Datum:` is read as Belgrade time, and the expense is dated that moment's day in your timezone.
  An SMS dated after the day you send it is refused.
- The description is the `Mesto:` merchant, without its trailing country code and phone number.
- The same SMS pasted again, however its lines are wrapped, records nothing and answers «Уже
  записано» with the existing card.
- An SMS whose header matches but whose body can't be read, or whose currency the bot doesn't
  know, is refused, and nothing is recorded.

Groups ignore bank SMS.

### Bank statements

In a private chat, send a Raiffeisen banka Srbija account statement («Izvod po tekućem računu»),
downloaded from e-banking as a PDF, and its card purchases become expenses
([ADR-0032](docs/adrs/0032-statement-rows-match-recorded-expenses.md),
[ADR-0033](docs/adrs/0033-pdf-statements-via-pdfjs-dist.md)). Other banks, and the bank's XLSX
and CSV exports, aren't read yet. A PDF that isn't such a statement gets the `/help` answer.

- The bot answers with a preview: the period, how many card purchases it found, how many are
  new and how many are already recorded, the new ones' totals per currency, and the rows ten per
  page. [Записать все (N)] records the new ones, [Записать и уже записанные] records the rest as
  well, and [Отмена] drops the statement. The buttons work for 10 minutes.
- Only card purchases are read. Cash withdrawals, bank fees, transfers, income and reversals are
  skipped. A foreign purchase's conversion charge, a second small row in EUR, is its own expense.
- Each expense is in the purchase's original amount and currency, dated the transaction date, in
  the category the bot suggests for the merchant, which learns from your corrections.
- A purchase counts as already recorded when an expense of the same amount and currency is
  dated within a day of it, however it was recorded: by hand, from a receipt or from an SMS.
  Sending the same statement again records nothing.
- Files over 5 MB, over 30 pages or with more than 1000 purchases are refused, and so is a
  scanned PDF without a text layer.
- A sealed ledger takes a statement only while unlocked, and the purchases are sealed like any
  expense.
- **Privacy:** the file is read in memory and never stored. Only the card purchases are kept:
  as expenses, and until you tap, in the pending preview. The statement's name, address,
  account number, balance and other rows are discarded. Logs carry counts only.

Groups ignore statement files.

### Encrypted ledger

Your personal ledger can be sealed so that only you can read it
([ADR-0020](docs/adrs/0020-sealed-ledgers-write-open-read-locked.md)). `/settings` →
[Шифрование] asks for a passphrase of at least 10 characters and shows a one-time recovery code
(8 groups of 4 characters) with [Сохранил], which deletes it. Every message carrying the
passphrase or the code is deleted as soon as it arrives.

- Amounts, descriptions and categories are sealed to the ledger's public key, so `450 кофе`
  records as before without the passphrase. Expenses recorded before the switch are sealed then,
  receipts with their items included.
- `/today`, `/week`, `/month`, `/budget` and taps on an expense card answer «Учёт зашифрован и
  закрыт» until `/unlock` and the passphrase. The ledger closes again after 30 minutes without a
  read, on `/lock`, and on every restart of the bot. A summary push to a locked ledger carries
  no figures, only [Показать].
- `/recover` takes the recovery code and then a new passphrase. While unlocked, [Шифрование] →
  [Сменить пароль] changes it. Losing both the passphrase and the code loses the data.
- A sealed ledger doesn't take receipt QR codes or links, and suggests categories from keywords
  only. The date, the currency and the number of expenses stay readable.
- A sealed ledger can't recognise a bank SMS by its content: the same SMS pasted again in a new
  message records a second expense, which [Удалить] on its card undoes.
- It protects the database file and backups taken after the switch. It does not protect against
  whoever runs the bot changing its code, or against Telegram, which sees every message. Backups
  taken before the switch keep plaintext until backup rotation (`BACKUP_KEEP`,
  `BACKUP_KEEP_WEEKLY`) drops them.

### Currency conversion

/today, /week, /month and the budget show one total in one currency
([ADR-0022](docs/adrs/0022-fx-nbs-middle-rate-ledger-currency.md),
[ADR-0023](docs/adrs/0023-budgets-count-converted-spending.md)):

- Reports convert into the ledger's default currency. A budget converts into its own currency,
  which can differ from the ledger's after a currency change.
- Each expense converts at the National Bank of Serbia middle rate list in force on its day. A day
  with no stored list uses the latest one up to 4 days earlier. An expense already in the target
  currency isn't converted.
- Each expense is converted in one exact step and rounded half-up to the target's minor units.
  A total is the sum of the rounded parts.
- A total with anything converted is marked `≈` and followed by
  `Включая 107.40 EUR, 6.00 USD по курсу НБС на день траты.`
- A currency NBS doesn't list (AMD, GEL, KZT, UAH, UZS), or a day with no rate yet, stays in its
  own block, named in `Без курса НБС, не пересчитано: KZT.` The budget lists it as
  `Не учтено, нет курса`.

A worker fetches the rate lists at boot and then hourly, so the bot needs outbound HTTPS to
`webappcenter.nbs.rs`. If NBS can't be reached, reports fall back to per-currency blocks.

### Donations

The bot is free for everyone, with no paid tier
([ADR-0027](docs/adrs/0027-donations-only-funding.md)). `/donate` works in a private chat only.

- At boot the bot creates one Telegram Stars invoice link per preset amount. A preset whose link
  can't be created is left out. With no link and no `DONATE_URL`, `/donate` says donations are
  unavailable.
- A payment is checked before Telegram takes it: the currency must be Stars and the amount must
  match the button's preset.
- A completed payment is stored once per Telegram charge id: the Stars amount, the donor's
  internal user id and the time. The donor gets one thank-you, and the admin one notice with the
  amount, the internal user id and the charge id, never a name.
- The private `/help` ends with a line pointing to `/donate`.
- The admin's `/refund <charge id>` returns the Stars through Telegram and marks the donation
  refunded. A second `/refund` of the same charge id doesn't call Telegram.

### Mini App: live receipt scan

With `WEBAPP_URL` set, the private-chat menu gains «📷 Скан»
([ADR-0025](docs/adrs/0025-static-mini-app-fragment-in-senddata-out.md)). It opens a static page
in scan mode, which opens Telegram's own live QR scanner. The first code read goes back to the
bot and is recorded exactly like a pasted receipt link, duplicate check included.

- The page lives in `webapp/`: `index.html` plus TypeScript built by `pnpm build:webapp` (plain
  `tsc`, no bundler, no runtime dependencies) into `webapp/dist/`. The `Pages` workflow
  publishes it to GitHub Pages on a push to `main` that touches it. Enable Pages with the source
  "GitHub Actions", then set `WEBAPP_URL` to the published URL, without a `#fragment`.
- The page makes no network request: its CSP allows scripts from `telegram.org` and itself only.
  The scanned text leaves the page only by `sendData`, and the bot never logs it.
- The live scanner exists on Telegram's mobile apps. Elsewhere (Desktop, web) the page says so,
  and a photo or the pasted link still works.
- Telegram keeps showing an old menu until the next `/start` or `/help` reply, so the button
  appears after one of them. A group never gets it: `web_app` buttons work in private chats only.

### Mini App: charts

With `WEBAPP_URL` set, `/week` and `/month` in a private chat end with «📈 Диаграмма». It opens
the same page in chart mode: the shown period's categories as a donut, in the ledger's currency,
with the period's total in its centre and a legend under it. The donut and the bars scale to the
screen width. Paging to another period rebuilds the button for that period.

- The bot puts the period's totals in the button URL's fragment (`#d=…`, base64url JSON), already
  formatted, so the page makes no request and does no money arithmetic. Only aggregates travel,
  never an individual expense, and the static host never sees the fragment.
- The donut holds the converted block (ADR-0022). A currency with no NBS rate is one text line
  under the chart, never part of the donut.
- Tapping a slice or a legend row shows that line's name and amount in the centre and dims the
  other slices. A second tap on it, or a tap in the centre, goes back to the total.
- The slice colours follow the Telegram theme, a light or a dark palette, and the chart redraws
  when the theme changes. Lines past the eighth are drawn in the theme's hint colour.
- Under the donut, 6 bars show the converted totals of the shown period and the five before it,
  oldest first. A period with nothing spent keeps its row with a zero-length bar.
- A period with no expenses, or with nothing in or converted into the ledger's currency, has no
  button. Neither does a group report or a locked sealed ledger.
- A damaged link, or one from a newer payload version, shows a line asking to reopen the report.

### Amount rules

One rule for everyone, regardless of locale ([ADR-0004](docs/adrs/0004-amount-parsing-rule.md)):

- `.` or `,` followed by 1–2 digits is a decimal separator: `12,5`, `12.50`.
- A space groups thousands in groups of three: `1 200`, `12 345 678`.
- A single `.` or `,` followed by exactly three digits (`1.200`, `1,200`) is ambiguous. The bot
  asks and never guesses, because a thousand-fold misread is the worst bug this product can
  have.
- Two separators (`1.200,50`), too many decimals for the currency, zero and negative amounts are
  rejected with a hint.

Supported currencies and their minor units are listed in
[`src/domain/currencies.ts`](src/domain/currencies.ts).

### Concepts

- **Ledger.** Every expense belongs to a ledger, never directly to a person. Each user starts
  with a personal ledger, and a group chat gets a shared one (see [In a group](#in-a-group)).
  Every confirmation names the ledger it wrote to
  ([ADR-0002](docs/adrs/0002-ledgers-and-identity.md)).
- **Local date.** An expense is filed under the date in _your_ timezone when you sent it, so an
  expense sent at 00:30 counts for the new day.
- **Original currency.** Amounts are stored as sent. Reports and budgets convert them at read
  time, never at record time
  ([ADR-0003](docs/adrs/0003-currency-conversion-at-report-time.md)).
- **Idempotent.** A message Telegram redelivers is never recorded twice.

## Running locally

Requirements: Node 24 (`.nvmrc`), and pnpm at the version pinned in `package.json`
`packageManager` (via Corepack or mise).

1. Create a bot with [@BotFather](https://t.me/BotFather). Use a **separate bot for
   development**, because two processes polling one token conflict.
2. Install and configure:

   ```sh
   pnpm install            # also installs the husky pre-commit hook
   cp .env.example .env    # fill in BOT_TOKEN and ADMIN_TELEGRAM_ID (your Telegram user id)
   pnpm dev                # long polling, restarts on change
   ```

3. Send `/start` to your bot.

Configuration is environment-only and validated at boot. Every variable is documented in
[.env.example](.env.example): token, the admin id and the ids admitted at boot, the timezone and
currency new users get, the SQLite path and the log level. Runtime data lives in `./data/`
(gitignored).

`ADMIN_TELEGRAM_ID` and `ADMIT_TELEGRAM_IDS` replace `ALLOWED_TELEGRAM_IDS`. A boot with the old
variable still set fails with a message naming the new ones: set `ADMIN_TELEGRAM_ID` to the old
first id and `ADMIT_TELEGRAM_IDS` to the rest, then remove `ALLOWED_TELEGRAM_IDS`.

## Running in Docker

Production runs compiled JavaScript from `dist/` in a multi-stage image
([ADR-0006](docs/adrs/0006-production-runs-compiled-js.md)). The same Compose file runs locally
and on the VPS:

```sh
cp .env.example .env         # a bot token that nothing else is polling
docker compose up -d --build --wait
docker compose logs -f bot
docker compose stop          # SIGTERM: heartbeat, polling, then the DB close cleanly
```

- The database lives on the named volume `bot-data` at `/app/data/bot.sqlite`. Compose sets
  `DATABASE_PATH` itself, so the value in `.env` is ignored in the container.
- Health is a heartbeat file next to the database, rewritten every 30 s once polling starts.
  `docker compose ps` shows the bot `unhealthy` when it is older than 120 s or missing.
- The container runs as uid 1000 (`node`). Backups go to the host directory `HOST_BACKUP_DIR`
  (default `/var/backups/personal-expenses-bot`), which must be owned by uid 1000.

Backup settings (the full list is in [.env.example](.env.example)):

| Variable             | Default                              | Meaning                                                                                                     |
| -------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `BACKUP_DIR`         | unset (no backups)                   | Where the bot writes `expenses-YYYY-MM-DD.sqlite.gz` (UTC date, gzip) at boot and every 24 h                |
| `BACKUP_KEEP`        | `7`                                  | How many daily backup files to keep                                                                         |
| `BACKUP_KEEP_WEEKLY` | `4`                                  | How many Sunday (UTC date) backup files to keep besides the dailies. A Sunday among the dailies counts once |
| `HOST_BACKUP_DIR`    | `/var/backups/personal-expenses-bot` | Compose only: the host directory bind-mounted as the container's `BACKUP_DIR`                               |

Compose sets `BACKUP_DIR` itself. Each backup is an online copy, gzip-compressed, then the
uncompressed copy is removed, so a backup briefly needs one uncompressed copy's worth of free
disk. Files older than both windows are deleted; an uncompressed `expenses-YYYY-MM-DD.sqlite`
from before compression counts as a daily by its date. A boot on a UTC day that already has a
backup writes none, and a failed backup is logged as an `error` without stopping the bot.
Deleted data can survive in a backup for `max(BACKUP_KEEP, 7 × BACKUP_KEEP_WEEKLY)` days (28 with
the defaults), which is what `/delete_account` says.

## Deploy

`.github/workflows/deploy.yml` runs `check` (install, typecheck, lint, build, test, and the deploy
script's own test) on every pull request and push to `main`. A push to `main` that passes `check`
connects over SSH with a key that can run only one thing: the deploy script
[scripts/deploy-vps.sh](scripts/deploy-vps.sh). It runs `git pull --ff-only`, then
`docker compose up -d --build --wait`, so a container that never turns healthy fails the run, and
then prunes dangling images and build cache older than a week. Deploys queue, never overlap.

Repository secrets:

| Secret     | Value                                   |
| ---------- | --------------------------------------- |
| `SSH_HOST` | VPS hostname or IP                      |
| `SSH_USER` | the deploy user (`botuser`)             |
| `SSH_KEY`  | the dedicated deploy key's private half |

VPS layout (the deploy user is uid 1000, in the `docker` group, with no sudo):

```text
~/bots/personal-expenses-bot/           # this repo, cloned over HTTPS (public repo, no deploy key)
~/bots/personal-expenses-bot/.env       # production token and ids, mode 0600, not in git
~/backups/personal-expenses-bot/        # expenses-YYYY-MM-DD.sqlite.gz, mode 0700
~/bin/deploy-personal-expenses-bot      # installed copy of scripts/deploy-vps.sh
```

Production uses its **own** BotFather bot. Two processes polling one token get 409 Conflict.

One-time setup on the VPS, as the deploy user:

```sh
git clone https://github.com/IgorKonovalov/personal_expenses_bot.git ~/bots/personal-expenses-bot
install -d -m 700 ~/backups/personal-expenses-bot
mkdir -p ~/bin
install -m 755 ~/bots/personal-expenses-bot/scripts/deploy-vps.sh ~/bin/deploy-personal-expenses-bot
```

The VPS `.env` sets `HOST_BACKUP_DIR=/home/botuser/backups/personal-expenses-bot`, next to the
sibling bots' backups.

The deploy key belongs to this repo alone. Generate it on a laptop with
`ssh-keygen -t ed25519 -N '' -C gha-deploy-personal-expenses-bot -f ./deploy-key`, put
`deploy-key` into the `SSH_KEY` secret, and append the public half to the VPS
`~/.ssh/authorized_keys` as one line:

```text
restrict,command="/home/botuser/bin/deploy-personal-expenses-bot" ssh-ed25519 AAAA... gha-deploy-personal-expenses-bot
```

Then delete both local copies. The deploy user's `docker` group makes any shell on it
root-equivalent, which is why this key gets no shell: sshd runs the forced command whatever the
client asks for. The installed script is a copy. **After changing `scripts/deploy-vps.sh`, rerun
the `install -m 755` line above**, or the VPS keeps running the old one.

Manual redeploy, on the VPS: `~/bin/deploy-personal-expenses-bot`.

If `git pull --ff-only` fails, someone edited the checkout on the VPS. Reset it to `origin/main`
rather than forcing a merge.

### Restoring a backup

1. Stop the bot: `docker compose stop bot`.
2. Unpack the backup into the volume, replacing the live file and dropping its WAL:

   ```sh
   docker compose run --rm --no-deps --entrypoint sh bot -c \
     'rm -f /app/data/bot.sqlite-wal /app/data/bot.sqlite-shm &&
      gunzip -c /var/backups/personal-expenses-bot/expenses-YYYY-MM-DD.sqlite.gz > /app/data/bot.sqlite'
   ```

   An uncompressed `expenses-YYYY-MM-DD.sqlite` from before compression is copied with `cp`
   instead of `gunzip -c … >`.

3. Start it: `docker compose up -d --wait`. Boot applies any newer migrations to the restored
   file.

To inspect a backup without restoring it, copy the file off the VPS, `gunzip` it, and open it
read-only with any SQLite client.

## Development

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Runs the bot with `tsx watch`, loading `.env` if present |
| `pnpm build`     | Compiles `src/` to `dist/` and copies the SQL migrations |
| `pnpm start`     | Runs the compiled bot, `node dist/index.js`              |
| `pnpm typecheck` | `tsc --noEmit`, strict                                   |
| `pnpm lint`      | ESLint (type-aware), including the layer-boundary rules  |
| `pnpm test`      | Vitest, against real in-memory SQLite (no DB mocks)      |
| `pnpm format`    | Prettier                                                 |

The pre-commit hook runs Prettier on staged files, then typecheck, lint and tests.

### Architecture

```
src/
├── domain/      pure: money, expense text, time windows, aggregation, sealing. No I/O, no framework
├── db/          SQLite connection, forward-only migrations, repositories. The only place with SQL
├── services/    use-cases orchestrating domain + db
├── bot/         the Telegram adapter (grammY): handlers, middleware, the Russian messages module
├── fiscal/      the receipts adapter: QR decoding and the tax-site fetchers
├── statements/  the bank-statement adapter: PDF text as positioned lines (pdfjs-dist, lazy)
├── fx/          the rates adapter: the NBS middle-rate fetcher and its hourly worker
├── config.ts    env -> typed config, validated at boot
├── logger.ts    pino factory
├── heartbeat.ts liveness file + the Docker health-check entry
├── version.ts   the running version, read from package.json at boot
└── index.ts     boot
```

Lint rules enforce the boundaries: grammY only under `src/bot/`, and no I/O or wall-clock
reads in `src/domain/`. Stack and rationale:
[ADR-0001](docs/adrs/0001-tech-stack.md) (Node 24, strict TypeScript, grammY long polling,
better-sqlite3, pnpm, Vitest).

Non-negotiables, in short:

- Money is an integer in minor units plus an ISO-4217 code. Floats are forbidden everywhere.
- Instants are stored in UTC, and "today" is computed in the user's timezone.
- Amounts and descriptions never appear in logs above `debug`.
- All user-facing text lives in [`src/bot/messages.ts`](src/bot/messages.ts).

Dependencies follow a supply-chain policy (`pnpm-workspace.yaml`): exact pins, a 7-day
release-age cooldown, and install scripts only for the native packages named in `allowBuilds`.

### How work is organised

Features are designed before they're built. The [plans index](docs/plans/README.md) holds
phased implementation plans, and the [ADR index](docs/adrs/README.md) holds decisions and their
rejected alternatives. [CLAUDE.md](CLAUDE.md) is the orientation map. It also describes the
agent skills in `.claude/` that write plans (`architect`), implement them (`dev`) and review chat
UX (`ux-telegram`), and the git hooks that guard commits. Approved plans can also run unattended
through the [conductor](tools/conductor/README.md)
([ADR-0010](docs/adrs/0010-approved-plans-run-under-a-forked-conductor-on-trial.md)).

## Roadmap

Active and drafted plans are listed in [docs/plans/README.md](docs/plans/README.md): currently
tags for projects and trips, debts between people, and onboarding.
Further out: fiscal receipts from Russia and Kazakhstan, more bank SMS templates, and CSV/XLSX
export.

## License

[MIT](LICENSE)
