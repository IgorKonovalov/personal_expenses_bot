# 0046: Group history import: a Telegram Desktop export brings in the expenses from before the bot joined

> **Status:** done (2026-10-08): built as planned after one fix pass, one minor and one nit open, Phase 6 real export owed, v0.37.0
> **Created:** 2026-10-07
> **Depends on:** [Plan 0045](0045-currency-words-and-amount-last-text.md) (currency words, `к`, `readTrailingExpense`, `chatterShaped`)
> **Related ADRs:** [ADR-0047](../../adrs/0047-group-history-import-from-a-desktop-export.md) (the decision),
> [ADR-0046](../../adrs/0046-currency-words-thousands-suffix-and-amount-last-text.md) (the readers),
> [ADR-0014](../../adrs/0014-group-chats-bind-to-shared-ledgers.md) (group ledgers),
> [ADR-0015](../../adrs/0015-shared-ledgers-carry-a-timezone.md) (dates in the ledger's timezone),
> [ADR-0009](../../adrs/0009-persisted-flow-sessions.md) (the pending flow, used only by [Исправить]),
> [ADR-0031](../../adrs/0031-local-time-scheduler.md) (the sweep's tick),
> [ADR-0008](../../adrs/0008-category-suggestion-from-history.md) (categories)

## TL;DR

The owner exports the family group's history from Telegram Desktop as JSON and sends `result.json`
to the bot in a private chat. The bot finds the group's ledger, reads every message sent before
it joined, and answers:

> **История группы** → «Семья», 01.07.2026–14.09.2026
> Готово к записи: 7 трат из 4 сообщений, на 15 500.00 RSD, 300.00 EUR
> Нужно проверить: 5 сообщений
> Без сумм, пропущено: 1 сообщение
> [Записать 7 трат] [Проверить (5)] [Отмена]

Ready expenses record under each message's sender, on its original date. The rest come one card at
a time, each saying why it needs a look: [Записать так], [Исправить] or [Пропустить]. A message
that starts with a name («Ира: …») is attributed to whoever the owner says «Ира» is. The group gets
one line saying history was added. [Отменить импорт] takes it all back, and sending the file again
records nothing twice.

## Context & problem

The bot only sees messages sent after it joined (ADR-0047). A family that kept expenses in the chat
before then starts with an empty ledger and months of history outside it. Those messages are free
text: one expense, a list with a total, comma-separated items in two currencies, a name prefix,
or chatter. Plan 0045 teaches the parser the single-expense shapes. This plan adds the splitting,
the export reading, the attribution and the review.

**No message from the family's real chat appears in this plan or in a fixture.** The examples below
are synthetic.

## Decision

- A domain module reads the export into messages: `src/domain/chatImport/telegramExport.ts`.
- A second domain module splits one message into proposed items and a verdict, ready or review:
  `src/domain/chatImport/readMessage.ts`.
- A service previews, records and undoes against the group's shared ledger:
  `src/services/importChat.ts`.
- The DM handler shows the preview, the review cards and the name-prefix questions:
  `src/bot/handlers/chatImport.ts`.
- **The import has its own table, `chat_imports`, one row per user.** It is not the pending-flow
  slot, so a command, a menu tap or another flow doesn't end it. It holds the read messages, each
  message's decision (recorded, skipped) and the prefix mappings, and lives 24 hours after the last
  tap. Sending the same chat's export again inside that window keeps the decisions. Only
  [Исправить]'s typed answer uses the pending-flow slot, with the usual 10-minute TTL.
- **Every import button carries the row's nonce**, so a button from an earlier upload never acts on
  a later one.
- Items are stored through `storeExpense`, with a category from `suggestCategory` and source key
  `tgx:<chatId>:<messageId>:<itemIndex>`.
- **[Отменить импорт] deletes the chat's `tgx:` expenses for good**, after a confirm step. The file
  is the backup: sending it again records them again (ADR-0047).
- **The group gets one notice**, edited in place as the count grows and when the import is undone.

We rejected forwards, pasted text and a Claude API reader (ADR-0047).

## Architecture diagram

```mermaid
sequenceDiagram
    participant U as Owner (DM)
    participant H as handlers/chatImport
    participant S as services/importChat
    participant D as domain/chatImport
    participant DB as SQLite
    participant G as Group
    U->>H: result.json
    H->>D: readTelegramExport(json)
    H->>S: previewChatImport(user, export)
    S->>DB: binding for -100<id> or -<id>, bound_at, membership
    S->>D: readMessage(text, ledger currency, message date) per message before bound_at
    S->>DB: upsert chat_imports (nonce, messages, decisions; 24 h)
    H-->>U: preview + [Записать 7 трат] [Проверить (5)] [Отмена]
    U->>H: [Записать 7 трат] (imp:rec:<nonce>)
    H->>S: recordReady(user, nonce)
    S->>DB: provision senders, join members, storeExpense per item (tgx keys)
    H-->>U: «Записано» + [Проверить (5)] [Отменить импорт]
    H->>G: notice «Из истории группы … добавлено 7 трат»
```

## Implementation phases

### Phase 1: Walking skeleton: an export records its ready messages
- **Owner skill:** dev
- **What:**
  - **Reading the file.** `readTelegramExport(text)` parses the JSON and returns the chat's `id`,
    `name` and `type`, and its messages. Only a `type` containing `group` is read; anything else,
    a private chat, a channel or a whole-account export, returns `notExport`. A message comes back
    only when its `type` is `"message"` and its `from_id` starts with `user`. For each one it keeps:
    - `id`;
    - the instant, from `date_unixtime` (seconds);
    - `from` (the sender's name), or `null` for a deleted account;
    - the sender's Telegram id, from `from_id` without `user`;
    - the text, joined from `text` whether that is a string or an array of strings and
      `{ text }` objects;
    - `forwarded: true` when `forwarded_from` is present.
  - **Splitting a message.** `readMessage(text, defaultCurrency, today)` splits the message into
    lines and drops empty ones. `today` is the message's local date in the ledger's timezone, so
    «вчера» in a July message means the day before it. A line with `, ` or `; ` is split there,
    but only when every piece then reads as an item. Each line or piece is read:
    - first by `parseExpenseText`;
    - then by `readTrailingExpense`;
    - an amount alone, or «итого/всего/итог» and an amount, is a total line.
  - A trailing «на» or «за» is dropped from an item's description.
  - **The verdict** is `ready` when all of these hold:
    - every line is an `expense` item or a total;
    - a total line equals the sum of the other items, which all share its currency;
    - no amount-last item is bare (Data shapes);
    - the message isn't forwarded, its sender isn't a deleted account, and it has no name prefix
      (a single word, then `:`, then text that reads as an item with a description).
  - Otherwise the verdict is `review`, with its reason. A message with no digit in it is
    `noAmount`.
  - **Storage.** Migration `0029_chat_imports.sql` adds `chat_imports` (Data shapes). A new export
    for the same chat keeps the row's decisions and gets a new nonce. An export of another chat
    replaces the row. `chatImportSweep` is registered with the scheduler in `src/index.ts` and
    deletes rows past `expires_at` on each tick. `/delete_account` deletes the user's row.
  - **The preview.** `previewChatImport` finds the binding whose chat id is `-100<id>` or `-<id>`.
    It refuses when there is none, or when the user isn't a member of the bound ledger, with the
    same copy for both. It reads the messages dated before the binding's `bound_at`. Messages
    already recorded (a `tgx:` key exists for them) and messages skipped in this row count as
    such and are not offered again. It returns the ready items and their totals per currency, the
    first and last message dates, and the review, recorded, skipped and no-amount counts.
  - **Recording.** [Записать N трат] records each ready item in one transaction:
    - the sender is provisioned and joins as a member, as `recordGroupExpense` does. The export
      name becomes the display name only when the user has none yet;
    - `occurred_at` is the message's instant, and `occurred_on` its date in the ledger's timezone;
    - the category comes from `suggestCategory` with the ledger's history.
  - The reply says what was recorded, in totals per currency, and how many landed in «Другое».
    [Отмена] deletes the row.
  - A tap whose nonce doesn't match the row answers `chatImportStale`; with no row, or past
    `expires_at`, `chatImportExpired`.
  - The handler takes a document named `*.json` or typed `application/json`, and is registered
    before the statement handler.
  - Copy (illustrative messages-module entries; `tratCount`/`messageCount` are plural helpers):

    ```ts
    chatImportPreview: ({ ledger, from, to, readyCount, readyMessages, totals, alreadyCount, skippedCount, reviewCount, noAmountCount }) =>
      joinHtml([
        html`<b>История группы</b> → «${ledgerName(ledger)}», ${numericDate(from)}–${numericDate(to)}`,
        readyCount === 0
          ? html`Новых трат, готовых к записи, нет.`
          : html`Готово к записи: ${tratCount(readyCount)} из ${messageCount(readyMessages)}, на ${moneyTotals(totals)}`,
        ...(alreadyCount > 0 ? [html`Уже записано: ${messageCount(alreadyCount)}`] : []),
        ...(skippedCount > 0 ? [html`Пропущено вами: ${messageCount(skippedCount)}`] : []),
        ...(reviewCount > 0 ? [html`Нужно проверить: ${messageCount(reviewCount)}`] : []),
        ...(noAmountCount > 0 ? [html`Без сумм, пропущено: ${messageCount(noAmountCount)}`] : []),
      ], '\n'),
    chatImportRecordButton: (n) => `Записать ${tratCount(n)}`,
    chatImportReviewButton: (n) => `Проверить (${n})`,
    chatImportRecorded: ({ ledger, count, totals, otherCount }) =>
      html`Записано в «${ledgerName(ledger)}»: ${tratCount(count)} на ${moneyTotals(totals)}.` +
      (otherCount > 0 ? html` В «Другое»: ${otherCount} — категорию можно сменить в /month.` : html``),
    chatImportCancelled: html`Импорт отменён, ничего не записано.`,
    chatImportGroupUnknown: html`Не нашёл эту группу среди ваших. Добавьте меня в группу и запишите там одну трату, например «450 кафе», потом отправьте файл ещё раз.`,
    chatImportNotExport: html`Это не выгрузка группы. В Telegram Desktop откройте группу → ⋮ → «Экспорт истории чата», формат «Машиночитаемый JSON», и отправьте файл result.json.`,
    chatImportStale: 'Кнопка от прошлой выгрузки. Продолжите в последнем сообщении.',
    chatImportExpired: html`Импорт устарел: прошло больше суток. Отправьте файл ещё раз — уже записанное не повторится.`,
    ```
- **Files touched:** `src/domain/chatImport/telegramExport.ts`,
  `src/domain/chatImport/telegramExport.test.ts`, `src/domain/chatImport/readMessage.ts`,
  `src/domain/chatImport/readMessage.test.ts`, `src/db/migrations/0029_chat_imports.sql`,
  `src/db/chatImports.ts`, `src/db/chatImports.test.ts`, `src/services/importChat.ts`,
  `src/services/importChat.test.ts`, `src/services/groupChats.ts`,
  `src/services/deleteAccount.ts`, `src/services/deleteAccount.test.ts`, `src/db/ledgerChats.ts`,
  `src/bot/handlers/chatImport.ts`, `src/bot/chatImportSweep.ts`,
  `src/bot/chatImportSweep.test.ts`, `src/bot/bot.ts`, `src/bot/callbackData.ts`,
  `src/bot/callbacks.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`,
  `src/bot/testHarness.ts`, `src/index.ts`.
- **Done when:**
  - In an RSD ledger, `readMessage` returns:

    | Message | Items | Verdict |
    |---|---|---|
    | `Чайник 3200` | 320000 RSD «Чайник» | `ready` |
    | `Краска 2000\nкисти 500\nваликов на 800\n3300 дин` | 200000 «Краска», 50000 «кисти», 80000 «валиков» (2000 + 500 + 800 = 3300, so the total line is dropped) | `ready` |
    | the same with `3400 дин` last | the same three items | `review`, `total` |
    | `ремонт 300€, доставка 4500 динар` | 30000 EUR «ремонт», 450000 RSD «доставка» | `ready` |
    | `Шкаф: 4500` | 450000 RSD «Шкаф» (`Шкаф:` is not a prefix: «4500» has no description) | `ready` |
    | `буду в 7` | | `review`, `bare` |
    | `Ира: ремонт 300€` | | `review`, `prefix` |
    | `Лампа 1.500` | | `review`, `ambiguous` |
    | `привет всем` | | `noAmount` |
  - `readMessage('Чайник 3200 вчера', 'RSD', '2026-07-21')` has `occurred_on` 2026-07-20.
  - A synthetic export for a bound supergroup has `id` 1234567890, so the binding's chat is
    `-1001234567890`, and `bound_at` 2026-09-15T00:00:00Z. Its messages are the table's nine (one
    each, from senders A and B, dated 2026-07-01 to 2026-09-14), one forwarded copy of
    `Чайник 3200`, and one `Чайник 3200` dated 2026-09-16. The preview then has:
    - 7 ready items in 4 messages;
    - totals 1550000 RSD and 30000 EUR (3200 + 3300 + 4500 + 4500 = 15 500.00 RSD);
    - 5 messages to review (the `3400` list, `буду в 7`, the prefix, the ambiguous one, the
      forward);
    - 1 without amounts;
    - the range «01.07.2026–14.09.2026».
    The 2026-09-16 message isn't read.
  - [Записать 7 трат] stores 7 expenses:
    - each `created_by` is its message's sender;
    - B, who never started the bot, gets a user row and membership with display name «B»;
    - a sender who already has a display name keeps it;
    - `Чайник 3200` sent 2026-07-20T22:30:00Z has `occurred_on` 2026-07-21 in Europe/Belgrade
      (CEST, UTC+2).
  - `/month` between the preview and the tap leaves the import working: [Записать 7 трат] still
    stores 7.
  - Sending the same file again previews «Новых трат, готовых к записи, нет.» and «Уже записано:
    4 сообщения», and recording stores nothing new.
  - A second tap on [Записать 7 трат] stores nothing new.
  - After the file is sent again, a tap on the first preview's [Записать 7 трат] answers
    `chatImportStale` and stores nothing.
  - With the row's `expires_at` passed, the sweep deletes it, and a tap answers
    `chatImportExpired`.
  - An export of an unbound chat, and one of a group whose ledger the user isn't a member of, get
    the same `chatImportGroupUnknown` reply.
  - A `.json` file that isn't a group export, including an export of a private chat, gets
    `chatImportNotExport`.
  - After `/delete_account`, the user's `chat_imports` row is gone.

### Phase 2: Review cards
- **Owner skill:** dev
- **What:**
  - [Проверить (N)] opens the first review message as a card, a new message that later taps edit
    in place. The card shows:
    - «Проверка 3 из 5»;
    - the sender's name, or `deletedMember` for a deleted account, and the message's date;
    - the message text, escaped and cut at 600 characters;
    - the reason, one line from `chatImportReason`;
    - the proposed items, if any;
    - «Платит: <имя>».
  - Its keyboard, one row each:
    - [Записать так], shown only when there are proposed items and none is ambiguous;
    - for an ambiguous item, one button per reading, as in ADR-0004, which records that reading;
    - [Исправить] [Пропустить];
    - [👤 <имя>], which cycles the payer through the export's senders. A deleted-account message
      starts with no payer, and [Записать так] appears once one is chosen;
    - [Закончить проверку].
  - [Исправить] edits the card into `chatImportFixPrompt` with [« Назад к карточке], and claims the
    next text through the pending-flow slot (10 minutes). The typed answer is read line by line
    with `parseExpenseText` and then `readTrailingExpense`, with the message's date as `today`.
    Every line must read, or the bot asks again with `chatImportFixBadLine`. The card then shows
    the typed items with [Записать так]. A command or another flow ends only the prompt; the card's
    buttons keep working.
  - Recording a card stores its items with source keys `tgx:<chatId>:<messageId>:<i>`, marks the
    message recorded in the row, and moves to the next card. [Пропустить] marks it skipped.
  - After the last card, or on [Закончить проверку], the card becomes `chatImportReviewDone`. If
    ready items are still unrecorded, it keeps [Записать N трат].
  - Copy (illustrative):

    ```ts
    chatImportReason: {
      total: ({ items, stated }) => html`Сумма строк ${moneyTotals(items)}, а в итоге ${formatMoney(stated)}.`,
      bare: html`Похоже на обычное сообщение, а не трату.`,
      unread: html`Не все строки понял.`,
      ambiguous: html`Сумму можно понять по-разному.`,
      prefix: html`Сообщение начинается с имени.`,
      forwarded: html`Пересланное сообщение: платить мог другой человек.`,
      deletedSender: html`Автор удалил аккаунт: выберите, кто платил.`,
    },
    chatImportPayer: (name) => html`Платит: ${name}`,
    chatImportFixPrompt: html`Отправьте траты из этого сообщения, по одной в строке, например:\n2000 краска\n500 кисти\nДата будет как у сообщения.`,
    chatImportFixBadLine: ({ n, line }) => html`Строку ${n} («${line}») не понял. Отправьте все строки ещё раз.`,
    chatImportReviewDone: ({ recorded, skipped }) => html`Проверка закончена: записано ${messageCount(recorded)}, пропущено ${skipped}.`,
    chatImportFinishButton: 'Закончить проверку',
    chatImportBackToCardButton: '« Назад к карточке',
    ```
- **Files touched:** `src/services/importChat.ts`, `src/services/importChat.test.ts`,
  `src/services/flowSessions.ts`, `src/bot/flows.ts`, `src/bot/handlers/chatImport.ts`,
  `src/bot/callbackData.ts`, `src/bot/callbacks.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - For the `3400` list, the card says «Сумма строк 3 300.00 RSD, а в итоге 3 400.00 RSD.»,
    proposes the three items, and [Записать так] stores 330000 RSD in total.
  - For `буду в 7`, [Пропустить] stores nothing and shows the next card.
  - For the ambiguous `Лампа 1.500` there is no [Записать так]. The [1 500.00 RSD] button stores
    150000 RSD «Лампа». [Исправить] with `1500 лампа` stores 150000 RSD «лампа» instead.
  - [Исправить] with `шкаф 4500\nх` answers that line 2 («х») can't be read, and stores nothing.
  - [Исправить], then `/today`, then [Пропустить] on the same card: the card skips, and the next
    text is read as an expense, not as a correction.
  - [👤] on A's card makes B the payer, the card says «Платит: B», and the item's `created_by` is
    B's user.
  - A message from a deleted account shows «Автор удалил аккаунт: выберите, кто платил.» and no
    [Записать так] until [👤] picks a payer.
  - A double tap on [Записать так] stores the items once.
  - [Закончить проверку] on card 2 of 5, before the ready items were recorded, shows the summary
    with [Записать 7 трат].
  - Sending the file again after skipping `буду в 7` previews «Пропущено вами: 1 сообщение» and 4
    messages to review.

### Phase 3: Name prefixes
- **Owner skill:** dev
- **What:**
  - Before the preview, the bot asks about each distinct name prefix, in order of first
    appearance, editing one message in place (`chatImportPrefixAsk`). It offers a button for each
    of the export's senders, up to 8, most messages first, two to a row, then [Автор сообщения]
    [Это не имя], then [Отмена].
  - A prefix mapped to a sender is cut from its messages, and their payer becomes that sender.
    [Автор сообщения] cuts the prefix and keeps each message's own sender. Either way the messages
    are then classified like any message.
  - [Это не имя] keeps the prefix in the text, and those messages stay `review`.
  - The mappings are stored in the row, so a re-sent file doesn't ask again.
  - Copy (illustrative):

    ```ts
    chatImportPrefixAsk: ({ prefix, count, example, n, total }) =>
      html`Имя ${n} из ${total}. ${messageCount(count)} начинаются с «${prefix}:», например: «${example}». Кто платил?`,
    chatImportPrefixAuthorButton: 'Автор сообщения',
    chatImportPrefixNotNameButton: 'Это не имя',
    ```
- **Files touched:** `src/domain/chatImport/readMessage.ts`,
  `src/domain/chatImport/readMessage.test.ts`, `src/services/importChat.ts`,
  `src/services/importChat.test.ts`, `src/bot/handlers/chatImport.ts`, `src/bot/callbackData.ts`,
  `src/bot/callbacks.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - The prefix of `Ира: ремонт 300€` is «Ира».
  - The prefix of `Шкаф: 4500` is none.
  - The prefix of `Мойка высокого давления: 7000` is none: more than one word.
  - In the Phase 1 export, mapping «Ира» to sender B makes the message ready. The preview then has
    8 ready items in 5 messages, and EUR totals 60000. The item's `created_by` is B.
  - Mapping «Ира» to [Автор сообщения] makes the same message ready, with `created_by` its sender.
  - With [Это не имя], the preview is unchanged from Phase 1.
  - Two messages starting `Ира:` give one question, «Имя 1 из 1. 2 сообщения начинаются с «Ира:»…».
  - Sending the file again after mapping «Ира» asks nothing and previews 8 ready items.

### Phase 4: Undo and the group notice
- **Owner skill:** dev
- **What:**
  - The first recording of an import, from [Записать N трат] or a card, posts `chatImportNotice` to
    the group, silently. Its message id is stored in the row, and every later recording or undo
    edits it in place. It names the importer and counts; it carries no amounts or descriptions.
  - The «Записано» reply and the review summary carry [Отменить импорт] while the row lives.
    It asks `chatImportUndoConfirm` with [Да, удалить] and [Нет]. [Да, удалить] deletes, in one
    transaction, every expense in the bound ledger whose source key starts with `tgx:<chatId>:`,
    clears the row's recorded marks, and edits the notice. The delete respects every table that
    references `expenses`; dev lists them in the implementation log.
  - Copy (illustrative):

    ```ts
    chatImportNotice: ({ importer, to, count }) =>
      html`Из истории группы до ${numericDate(to)} добавлено ${tratCount(count)} (импорт: ${importer}).`,
    chatImportNoticeUndone: ({ importer }) => html`Импорт истории группы отменён (${importer}).`,
    chatImportUndoButton: 'Отменить импорт',
    chatImportUndoConfirm: ({ count }) =>
      html`Удалить ${tratCount(count)} из истории группы? Их увидят все в группе. Файл можно будет отправить снова.`,
    chatImportUndoYesButton: 'Да, удалить',
    chatImportUndoNoButton: 'Нет',
    chatImportUndone: ({ count }) => html`Удалено ${tratCount(count)}. Чтобы записать заново, отправьте файл ещё раз.`,
    ```
- **Files touched:** `src/services/importChat.ts`, `src/services/importChat.test.ts`,
  `src/db/expenses.ts`, `src/db/expenses.test.ts`, `src/bot/handlers/chatImport.ts`,
  `src/bot/callbackData.ts`, `src/bot/callbacks.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - [Записать 7 трат] by A posts one silent group message, «Из истории группы до 14.09.2026
    добавлено 7 трат (импорт: A).». Recording the `3400` card after it edits the same message to
    10 трат, and posts nothing new.
  - [Отменить импорт], then [Да, удалить], leaves no expense with a `tgx:` key in the ledger, keeps
    every `tg:` and other expense, and edits the notice to the undone line.
  - [Отменить импорт], then [Нет], deletes nothing.
  - After the undo, sending the file again previews 7 ready items, and [Записать 7 трат] stores 7.
  - A double tap on [Да, удалить] deletes once and answers the second tap without an error.
  - The notice text contains no amount and no description.

### Phase 5: Limits, help and docs
- **Owner skill:** dev
- **What:**
  - A file over 10 MB is refused before download, and an export with more than 20 000 messages
    or a preview with more than 3 000 items is refused:

    ```ts
    chatImportTooLarge: html`Файл больше 10 МБ. Выгрузите историю по частям: в окне экспорта Telegram Desktop можно выбрать период.`,
    chatImportTooManyMessages: html`В выгрузке больше 20 000 сообщений. Выгрузите историю по частям, выбрав период.`,
    chatImportTooManyItems: html`В выгрузке больше 3 000 трат. Выгрузите историю по частям, выбрав период.`,
    ```
  - The ready list is paged at 10 items per page, under the preview's counts, one line each:
    `20.07 · Ира · <b>3 200.00 RSD</b> — Чайник`. The pager row is `[⬅ Назад] [1/3] [Вперёд ➡]`.
  - `/help` names the import in one line:

    ```ts
    html`История группы до того, как меня добавили: в Telegram Desktop откройте группу → ⋮ → «Экспорт истории чата», формат «Машиночитаемый JSON», без медиа, и отправьте мне файл result.json.`,
    ```
  - README gets a «History import» section with the steps, the before-the-bot window, how
    attribution works, the group notice and the undo.
  - CLAUDE.md's `domain/` line gains «chat import».
- **Files touched:** `src/services/importChat.ts`, `src/services/importChat.test.ts`,
  `src/bot/handlers/chatImport.ts`, `src/bot/messages.ts`, `src/bot/bot.test.ts`, `README.md`,
  `CLAUDE.md`.
- **Done when:**
  - A document with `file_size` 10485761 (10 MB plus one byte) gets the size refusal, and
    `getFile` is never called.
  - A synthetic export of 20 001 messages is refused with the count limit.
  - With 23 ready items, there are 3 pages (10, 10, 3), and the pager reads «1/3».
  - A page line for `Чайник 3200` from A on 2026-07-21 reads «21.07 · A · 3 200.00 RSD — Чайник».
  - No log line above debug carries a message text, a description or an amount. A test records the
    logger's calls through a full import, review and undo, and checks them.

### Phase 6: A real export
- **Owner skill:** human
- **Blocks merge:** no
- **What:** After deploying, export the family group from Telegram Desktop as JSON with no media,
  and send `result.json` to the bot.
- **Done when:**
  - The bot finds the group. If it doesn't, note the export's `type` and `id` in the plan, without
    the messages.
  - The ready count looks right on a spot check of a few pages.
  - The review cards and the name prefixes are worked through.
  - The group shows one notice with the final count.
  - `/month` for a past month matches what the chat said was spent.

## Data shapes

```ts
// illustrative: src/domain/chatImport/telegramExport.ts
interface ExportedMessage {
  readonly id: number;              // the Telegram message id in that chat
  readonly at: Date;                // from date_unixtime
  readonly senderTelegramId: number;
  readonly senderName: string | null; // `from`; null for a deleted account
  readonly text: string;
  readonly forwarded: boolean;
}
type ExportRead =
  | { kind: 'export'; chatId: number; name: string; messages: readonly ExportedMessage[] }
  | { kind: 'notExport' };

// illustrative: src/domain/chatImport/readMessage.ts
interface ProposedItem { amountMinor: number; currency: CurrencyCode; description: string; occurredOn: LocalDate }
type MessageRead =
  | { verdict: 'ready'; items: readonly ProposedItem[] }
  | { verdict: 'review'; items: readonly ProposedItem[]; reason: 'total' | 'bare' | 'unread' | 'ambiguous' | 'prefix' | 'forwarded' | 'deletedSender'; prefix?: string }
  | { verdict: 'noAmount' };
```

```sql
-- 0029_chat_imports.sql (illustrative)
CREATE TABLE chat_imports (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  chat_id TEXT NOT NULL,
  nonce TEXT NOT NULL,              -- 6 base-36 chars, new on every upload
  payload TEXT NOT NULL,            -- JSON: read messages, per-message decisions, prefix mappings
  notice_message_id INTEGER,        -- the group notice, edited in place
  expires_at TEXT NOT NULL          -- UTC; 24 h after the upload or the last tap
);
CREATE INDEX chat_imports_expires ON chat_imports(expires_at);
```

**Bare amount-last item:** read by `readTrailingExpense` with no currency word or `к`, and either
`chatterShaped` (Plan 0045) is true or the amount is under 100 whole units. A `?` never gets here:
`readTrailingExpense` refuses it. This is a heuristic to keep chatter like «буду в 7» out of the
bulk record. It is labelled as such in code.

The export fields used, as known at planning time and unverified until Phase 6:
- top-level `id` (number), `name` and `type`;
- `messages[]` with `id`, `type`, `date_unixtime` (a string of seconds), `from` (null for a
  deleted account), `from_id` (`user<digits>`), `text` (a string, or an array of strings and
  `{ type, text }`), and `forwarded_from`.

Callback data, with `<n>` the row's 6-char nonce, `<i>` a message index (at most 5 digits, since
an export holds at most 20 000 messages) and `<r>` a reading index:
- `imp:rec:<n>`, `imp:rev:<n>`, `imp:x:<n>`, `imp:pg:<n>:<page>`, `imp:end:<n>`;
- `imp:ok:<n>:<i>`, `imp:fix:<n>:<i>`, `imp:back:<n>:<i>`, `imp:skip:<n>:<i>`, `imp:who:<n>:<i>`,
  `imp:rd:<n>:<i>:<r>`;
- `imp:map:<n>:<prefixIndex>:<senderIndex|a|x>`;
- `imp:undo:<n>`, `imp:undoy:<n>`, `imp:undon:<n>`.

The longest is `imp:back:<n>:<i>` or `imp:skip:<n>:<i>`: 9 + 6 + 1 + 5 = 21 bytes, under 64.

## Risks & open questions

- **The export format is undocumented.** The chat-id mapping (`-100<id>` for supergroups, `-<id>`
  for basic groups) is tried both ways because it is unverified, and so is the `type` check.
  Phase 6 is the check.
- **Money:** items are minor-unit integers from `parseExpenseText`. A total is compared in minor
  units within one currency. A message mixing currencies with a total line goes to review.
- **Time:** `occurred_on` is the message's local date in the ledger's timezone (ADR-0015), never
  the import day, and date words read relative to it. Messages are read by instant, against
  `bound_at`.
- **Idempotency:** each source key is chat, message and item index. Re-sending the file, a double
  tap and a crash mid-record all leave one row per item. The nonce keeps an old button from
  acting on a new upload. A message the bot saw live has a `tg:` key, and the window before
  `bound_at` keeps it out.
- **Undo is a hard delete.** Source keys are unique even on soft-deleted rows, so a soft delete
  would block re-importing. The confirm step and the file as the backup make it recoverable
  (ADR-0047).
- **Privacy:**
  - The file is read in memory. The read messages sit in `chat_imports` for at most 24 hours
    after the last tap; the sweep and `/delete_account` delete them.
  - A shared ledger is never sealed (ADR-0020), so nothing sealed is exposed.
  - The group notice carries a name and a count, never amounts or text.
  - Logs carry counts only.
  - Provisioning senders who never started the bot matches live group recording (ADR-0014).
- **Re-binding:** if the bot was removed and re-added, messages sent while it was out are after
  `bound_at` and are not imported. That is out of scope (below).

## What this plan does NOT do

- An import for a private ledger, or from a chat that isn't bound to a group ledger.
- Messages sent while the bot was out of the group, after it first joined.
- Photos of receipts in the history. Only text and captions are read.
- Live multi-item or name-prefixed messages in the group (Plan 0045 covers single items).
- Tags, `/N` splits or debts from imported text.
- Going back to an earlier review card. A wrong [Пропустить] is redone by sending the file after
  the row expires, or by recording the expense by hand.

## Implementation log

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: an export records its ready messages | dev | done | 0bad4f1 |
| 2: Review cards | dev | done | fd8f901 |
| 3: Name prefixes | dev | done | 6f3042b |
| 4: Undo and the group notice | dev | done | b8d79e7 |
| 5: Limits, help and docs | dev | done | 228b20c |
| 6: A real export | human | owed | |

### Notes

- Phase 1: `src/services/groupChats.ts` was listed but not touched. The membership insert that
  keeps a stored display name is `joinImportedMember` in `src/db/chatImports.ts`, since
  `src/db/ledgers.ts` is outside the phase's files.
- Phase 1: the preview shows [Записать N трат] and [Отмена] only; [Проверить (N)] comes with
  Phase 2's handler. With nothing ready, the [Записать] button is left out.
- Phase 1: a message whose lines read but hold no item (a lone total line) is `review`/`unread`,
  not `total`. A `/N` split or a future date leaves its line unread.
- Phase 1: the JSON file is downloaded in the handler through `telegramFileDownloader`, not
  through the heavy-job queue.
- Phase 1: `ReadItem` adds an `AmbiguousItem` (readings instead of an amount) to the plan's
  `ProposedItem`; a review result carries `stated` for a `total` reason.
- Phase 1: the record button's count is in the accusative (`Записать 1 трату`); the preview line
  after «из» is in the genitive (`из 4 сообщений`, `из 1 сообщения`).
- Phase 2: `src/bot/callbacks.ts` was listed but not touched.
- Phase 2: `Лампа 1.500` in RSD reads two ways, so its card has two reading buttons,
  [1 500.00 RSD] and [1.50 RSD]. The test taps the first. A reading button resolves the card's
  first ambiguous item; the card records once no ambiguous item is left and someone pays.
- Phase 2: in an [Исправить] answer, a line that reads as an ambiguous amount or carries a `/N`
  split counts as unread. A trailing «на»/«за» is kept in a typed description.
- Phase 2: the «Записано» reply carries [Проверить (N)] while messages remain to review.
- Phase 2: with no payer, [👤] reads «👤 Кто платил?». The cycle skips senders with no name
  (deleted accounts).
- Phase 2: the card shows the message in a `<blockquote>` and each item as `• <amount> — <text>`.
  An ambiguous item lists its readings joined by «или».
- Phase 2: the queue of cards is the review messages as of the last preview, stored in the row;
  «Проверка k из N» counts in it.
- Phase 2: an [Исправить] answer whose upload went stale or expired ends the prompt and replies
  `chatImportStale` or `chatImportExpired`.
- Phase 3: `src/bot/callbacks.ts` was listed but not touched.
- Phase 3: `previewChatImport` always returns the preview, with a `question` while a prefix is
  unanswered; the handler shows the question first. The questions are asked about the messages
  not yet recorded or skipped; the prefixes are matched case-insensitively.
- Phase 3: the question's verb agrees with the count: «1 сообщение начинается», «2 сообщения
  начинаются». The example is cut at 100 code points.
- Phase 3: a prefix answered as a sender also clears a deleted account's `deletedSender` reason,
  since the payer is then known.
- Phase 3: the Phase 1 and 2 bot tests upload through a helper that answers «Ира» with
  [Это не имя]; the Phase 1 preview test reads the preview from the question's message, edited.
- Phase 4: the tables that reference `expenses`: `receipts` (and `receipt_items` through it),
  `recurring_occurrences.expense_id` and `debt_ops.expense_id`. The undo deletes the receipts and
  their items and sets the other two to NULL (`deleteExpensesByKeyPrefix`).
- Phase 4: `src/bot/callbacks.ts` was listed but not touched.
- Phase 4: the notice names the importer by their display name in the ledger. In the bot test A
  is «Test», so the notice reads «(импорт: Test).», not «(импорт: A).».
- Phase 4: [Нет] on the confirm step edits the message into the import's current preview, and
  the preview carries [Отменить импорт] while any message is already recorded.
- Phase 4: a second [Да, удалить] answers the tap and edits nothing. A failed group post or edit
  is logged as a warning with the error message and leaves the DM flow as it is.
- Phase 4: the «Записано» reply always carries [Отменить импорт], even when the tap recorded
  nothing new.
- Phase 5: `src/bot/callbackData.ts` was edited though not listed: it gained `CHAT_IMPORT_PAGE`
  and `chatImportPageData` for the Data shapes' `imp:pg:<n>:<page>`, since ADR-0011 builds all
  callback data there.
- Phase 5: the pager is the shared `pagerRow` of ADR-0011, `[◀] [1/3] [▶]` without [◀] on the
  first page and [▶] on the last, not `[⬅ Назад] [1/3] [Вперёд ➡]`.
- Phase 5: a page line's description is cut at 40 code points, as a drill-down line's is.
- Phase 5: the 3 000 cap counts the items of the ready messages and of the messages to review.
  Both refusals happen before the row is saved.
- Phase 5: the preview test of Phase 1 now asserts the seven page lines under the counts; the
  other preview assertions compare the count lines only.
- Followup, not acted on: the docs site (`site/`, ADR-0048) has no page on the history import;
  only `/help` and the README name it.
- Followup, not acted on: the group notice is posted after the DM reply, from the handler, with
  no tap guard. Updates are handled one at a time today, so two record taps can't both see no
  notice; a concurrent runner could post it twice.
- Review round 1, major 1 (review card past 4096 characters): fixed in a36fbb5. The card lists
  item lines while they fit, each description cut at 40 code points, then `…и ещё N трат`.
- Review round 1, nit 3 (`chatImportFixBadLine` echoes the line uncut): fixed in a561c48.
- Review round 1, minor 2 (ledger zone and currency against the defaults) and nit 4 (`totalsOf`
  against `sumByCurrency`): not acted on.

### Close triggers

- Phases 1 to 5 (`dev`) are done in 0bad4f1, fd8f901, 6f3042b, b8d79e7 and 228b20c. Phase 6
  (`human`, `Blocks merge: no`) has not started.
- Gate on the tip (228b20c):
  - `pnpm typecheck` exited 0.
  - `pnpm lint` exited 0.
  - `pnpm test` exited 0, with 151 files and 2254 tests passed.
  - `pnpm build` exited 0.
  - `node scripts/check-doc-links.mjs` exited 0, with 348 relative links resolving.
- New migration: `src/db/migrations/0029_chat_imports.sql` (the `chat_imports` table and its
  `expires_at` index), from Phase 1.
- New files: `src/domain/chatImport/telegramExport.ts`, `src/domain/chatImport/readMessage.ts`,
  `src/db/chatImports.ts`, `src/services/importChat.ts`, `src/bot/handlers/chatImport.ts`,
  `src/bot/chatImportSweep.ts`, and their tests.
- New pending-flow kind: `chatImportFix` in `src/services/flowSessions.ts`.
- New callback data scope: `imp:` in `src/bot/callbackData.ts`.
- User-facing copy changed: `/help` gains the history import line.
- Docs changed: README gains «History import»; CLAUDE.md's `domain/` line names chat import.

## Close review

Closed 2026-10-08 as v0.37.0. Phase 6 (`human`, a real export, `Blocks merge: no`) stays owed.

### Plan 0046 review, round 2 (tip c2019ed)

**Verdict:** The round 1 major is fixed and tested, and so is nit 3. No blocker or major is left,
so the plan can close. Round 1's minor 2 and nit 4 are still open, and they go to the plan's
`## Followups` at close.

#### Gate (run in this session, on c2019ed)

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm test`: exit 0. 151 files and 2256 tests passed. That is round 1's 2254 plus the two new
  tests.
- `node scripts/check-doc-links.mjs`: exit 0. 352 relative links resolve.
- The tree was clean before and after the run.

#### Scope of this round

The fix round is a36fbb5, a561c48 and c2019ed. Together they touch `src/bot/messages.ts`,
`src/bot/messages.test.ts`, `src/bot/bot.test.ts` and the plan's log. Round 1 already graded
Phases 1 to 5 in full, and nothing outside these files changed since e260af9.

#### Round 1 findings, rechecked

1. **Major 1, a review card past 4096 characters: resolved in a36fbb5.**
   - `chatImportItemLines` (`src/bot/messages.ts:935`) sums `visibleLength` for the head (header,
     sender, quote, reason), the payer tail and every item line. Above `MAX_VISIBLE_CHARS`, it
     keeps lines while they fit in 4096 minus 40, then closes with `…и ещё N трат`. The 40-character
     margin covers the closing line for any N an import can hold: a newline, `…и ещё `, up to
     five digits and ` трат`.
   - `chatImportItemLine` cuts each description at `MAX_LIST_DESCRIPTION` (40 code points), as the
     ready list does.
   - `visibleLength` counts UTF-16 units, which is how Telegram counts.
   - Only the display is cut. The service still records every item.
   - The test `src/bot/bot.test.ts:11486` reviews a card of 300 `a 1` lines with a `999 дин` total.
     It asserts:
     - `visibleLength(card) <= 4096`;
     - the header «Проверка 1 из 2»;
     - an `• 1.00 RSD — a` line, then `…и ещё N трат…`, then «Платит: A» at the end;
     - after [Пропустить], nothing is imported, and the card edits to «Проверка 2 из 2» from B.

     That defends the done-when the review asked for.
2. **Minor 2, nothing probes a ledger zone or currency that differs from the defaults: still
   open.** The log says "not acted on". See minor 1 below.
3. **Nit 3, `chatImportFixBadLine` echoes an uncut line: resolved in a561c48.**
   `src/bot/messages.ts:2420` cuts the line at `MAX_PREFIX_EXAMPLE` (100 code points) and adds `…`.
   The test `src/bot/messages.test.ts:31` passes a 5000-character line and asserts the exact
   string, with 100 code points and the ellipsis.
4. **Nit 4, `totalsOf` re-implements `sumByCurrency`: still open.** The log says "not acted on".
   See nit 1 below.

#### Layering and correctness of the fix

- The new code lives in the messages module and uses the module's own `visibleLength`,
  `MAX_VISIBLE_CHARS` and `spendCountWords`.
- It does no money arithmetic, and it adds no copy outside `src/bot/messages.ts`.
- `MAX_LIST_DESCRIPTION` is declared at `src/bot/messages.ts:954`, below its first use at line 924.
  It is only read when the function is called, after the module has loaded, so there is no
  temporal-dead-zone risk, and lint passes.

#### Findings

##### blocker

None.

##### major

None.

##### minor

1. **Nothing probes a ledger whose timezone or currency differs from the bot's defaults (carried
   from round 1, minor 2).**
   - **Where:** `src/services/importChat.test.ts:84-96`. There the ledger and `deps` both use
     `Europe/Belgrade` and RSD.
   - **What:** a regression that read `deps.timezone` or `deps.defaultCurrency` in place of the
     ledger's would pass every test.
   - **Why it matters:** it is the "two sources that agree in dev" case. The family's ledger is
     the one real ledger.
   - **Suggested fix:** add one service test with the ledger on `America/New_York` and EUR, and
     `deps` on Belgrade and RSD. Assert that `Чайник 3200` sent 2026-07-21T02:30Z records
     `occurred_on` 2026-07-20 in EUR.
   - Not blocking. At close, it goes to `## Followups`.

##### nit

1. **`totalsOf` re-implements `sumByCurrency` (carried from round 1, nit 4).**
   - **Where:** `src/services/importChat.ts:1251` and `src/domain/aggregate.ts:7`.
   - **Suggested fix:**
     `[...sumByCurrency(items)].map(([currency, amountMinor]) => ({ amountMinor, currency }))`.
   - At close, it goes to `## Followups`, or is dropped.

#### Bookkeeping owed (close session)

- Flip the plan's `Status:` to `done`, with the close date and this verdict. `git mv` the plan to
  `docs/plans/done/` and repair the links both ways. Verify with `node scripts/check-doc-links.mjs`.
- Accept ADR-0047 (`proposed` → `accepted`) and refresh `docs/adrs/README.md`.
- Refresh `docs/plans/README.md`: move the row to recently closed and bump the next free number.
- Version: a minor bump, since this adds a user-facing feature and a `/help` line. Add a
  `CHANGELOG.md` entry and a `versionAnnouncements` entry in `src/bot/messages.ts` (ADR-0013).
- Phase 6 (`human`, `Blocks merge: no`) stays owed after the close.
- Fill the plan's empty `## Followups` with:
  - the docs site (`site/`) has no history-import page;
  - the group notice has no tap guard against a concurrent runner posting it twice;
  - minor 1 above (a test with the ledger's zone and currency different from the defaults);
  - nit 1 above (`totalsOf` → `sumByCurrency`).
- README «History import» and the CLAUDE.md `domain/` line are already updated. There is no new
  env var.

### Earlier rounds

- Round 1, major 1 (a review card past 4096 characters): resolved in a36fbb5.
- Round 1, nit 3 (`chatImportFixBadLine` echoes the typed line uncut): resolved in a561c48.
- Round 1, minor 2 and nit 4: still open, carried as round 2's minor 1 and nit 1.

## Followups

- The docs site (`site/`, ADR-0048) has no page on the history import; only `/help` and the
  README name it.
- The group notice is posted from the handler with no tap guard. A concurrent runner could post it
  twice.
- No test probes a ledger whose timezone or currency differs from the bot's defaults (round 2,
  minor 1): one service test with the ledger on `America/New_York` and EUR, `deps` on Belgrade and
  RSD.
- `totalsOf` in `src/services/importChat.ts` re-implements `sumByCurrency` from
  `src/domain/aggregate.ts` (round 2, nit 1).
