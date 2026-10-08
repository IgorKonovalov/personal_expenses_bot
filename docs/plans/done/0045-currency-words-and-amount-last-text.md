# 0045: Currency words, a thousands suffix, and amount-last expense text

> **Status:** done (2026-10-08): built as planned, one minor and one nit open, Phase 5 live check owed, v0.35.0
> **Created:** 2026-10-07
> **Related ADRs:** [ADR-0046](../../adrs/0046-currency-words-thousands-suffix-and-amount-last-text.md) (the decision),
> [ADR-0004](../../adrs/0004-amount-parsing-rule.md) (amount parsing),
> [ADR-0014](../../adrs/0014-group-chats-bind-to-shared-ledgers.md) (group routing),
> [ADR-0031](../../adrs/0031-local-time-scheduler.md) (the scheduler tick)

## TL;DR

The bot learns to read expenses the way people actually write them:

- **A currency word or symbol names the currency.** `300 € ремонт` records 300.00 EUR «ремонт»,
  where today it silently records 300 dinars «€ ремонт».
- **`к` means thousands.** `45к дин шкаф` records 45 000.00 RSD «шкаф».
- **The amount may come last.** In a private chat, `Чайник 3200` records like `3200 чайник`. In a
  group, it gets a quiet question from the bot, «Записать 3 200.00 RSD — Чайник?», with
  [Записать] [Не трата], which only the sender can answer. Text with a `?`, and in a group text
  with a preposition before the amount («буду в 7»), stays chatter.

The first thing the user sees: `300 € ремонт` comes back as a card in euros.

## Context & problem

The parser reads `<amount> [ISO code] <description>` (ADR-0004). The family's group chat shows the
shapes it misses: currency symbols and words, `к` for thousands, and the amount last. The worst of
them is a symbol after the amount, which records the wrong currency without a word of warning. The
chat-history import (Plan 0046) needs all of these shapes read, and the live chat should read them
the same way. ADR-0046 records why amount-last text is a separate reader, and why the group asks
about it instead of recording it.

## Decision

- `src/domain/currencies.ts` gains `currencyOfWord(word)`, which reads an ISO code (any case) or an
  alias from the table under Data shapes.
- `parseExpenseText` reads:
  - a currency word after the amount;
  - a symbol or alias glued to the amount, after it (`300€`, `2500р`) or before it (`€300`);
  - `к`/`k` glued to the amount.
- `readTrailingExpense(text, currency, today)` rewrites amount-last text to amount-first and calls
  `parseExpenseText`. Text with a `?` is never amount-last.
- `chatterShaped(text)` flags a preposition before the amount («буду в 7»). The group uses it to
  skip the question, and Plan 0046 uses it to keep chatter out of the bulk record.
- `recordExpense` gains `forms: 'leading' | 'any'`, default `'leading'`. The private-chat text and
  ambiguity handlers pass `'any'`.
- The group text handler asks about amount-last text instead of recording it. A new table holds
  each pending question. A scheduler provider deletes the ones nobody answered.

We rejected recording amount-last text at once in the group, accepting it only with a marker, and
accepting it in the private chat only (ADR-0046).

## Architecture diagram

```mermaid
flowchart LR
    subgraph Telegram
      DM[private text]
      G[group text]
    end
    subgraph bot adapter
      T[handlers/text.ts]
      GT[group/text.ts]
      GA[group/ask.ts]
      P[groupAskProvider]
    end
    subgraph services
      R[recordExpense forms]
      GC[groupChats ask / answer]
    end
    subgraph domain
      E[parseExpenseText + currencyOfWord + к]
      TR[readTrailingExpense]
    end
    subgraph db
      A[(group_asks)]
    end
    DM --> T --> R --> E
    R -. forms any .-> TR --> E
    G --> GT --> GC
    GC -->|amount-last| A
    GA -->|[Записать]| GC --> R
    P -->|15 min, unanswered| A
```

## Implementation phases

### Phase 1: Walking skeleton: `300 € ремонт` records in euros
- **Owner skill:** dev
- **What:**
  - `currencyOfWord` and the alias table (Data shapes).
  - `parseExpenseText` reads the currency word after the amount, a currency symbol or alias glued
    after or before the amount, and the `к`/`k` suffix.
  - With the suffix, the integer part is whole units and a `.`/`,` fraction of 1 to 3 digits is a
    decimal fraction of a thousand. The result is `value × 1000` units, in minor units of the
    currency, computed on integers. With the suffix there is never an ambiguity question.
  - `к` as a separate word is not a suffix: `500 к чаю` keeps reading as 500 «к чаю».
- **Files touched:** `src/domain/currencies.ts`, `src/domain/currencies.test.ts`,
  `src/domain/expenseText.ts`, `src/domain/expenseText.test.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - In a ledger whose default currency is RSD:
    - `300 € ремонт` parses to 30000 minor units, EUR, description «ремонт».
    - `300€ ремонт` and `€300 ремонт` parse the same way.
    - `4500 динар доставка` parses to 450000, RSD, «доставка». `4500 дин доставка` and
      `4500 din доставка` parse the same.
    - `2500р такси` parses to 250000, RUB, «такси».
    - `20 $ кофе` parses to 2000, USD, «кофе».
  - `45к дин шкаф` parses to 4500000, RSD, «шкаф». `45k шкаф` parses to 4500000, RSD.
  - `1,5к кофе` and `1.5к кофе` parse to 150000 (1 500.00 RSD) with no ambiguity.
    `1.500к кофе` parses to 150000 too: 1.5 thousand, with no ambiguity.
  - In a JPY ledger (exponent 0), `1,5к рамен` parses to 1500.
  - `500 к чаю` parses to 50000, RSD, «к чаю». `500 р кофе` parses to 50000, RSD, «р кофе»,
    because a separate `р` is not an alias.
  - `500кг картошки` parses to the same result as before this phase: a glued `к` followed by
    more letters is not the suffix.
  - Every case already in `expenseText.test.ts` keeps its result.
  - In the private chat, `300 € ремонт` replies with a card showing «300.00 EUR».

### Phase 2: Amount-last text in the private chat
- **Owner skill:** dev
- **What:**
  - `readTrailingExpense(text, defaultCurrency, today?)` reads `<description> <amount>[к]
    [currency] [#tags…] [date]` on one line. A trailing `:`, `—` or `-` on the last description
    word is dropped (`Краска: 2000`).
  - The description must contain a letter. A `/N` split word makes the text unreadable as
    amount-last. Text with a line break is not amount-last. Text with a `?` anywhere is not
    amount-last: it is a question (ADR-0046).
  - `chatterShaped(text)` in the same module is true when the word right before the amount is
    one of «в, к, до, через, с, по, около, после», compared lower-cased. It is a heuristic and
    its comment says so. Phase 3 and Plan 0046 use it; the private chat does not.
  - The result is `parseExpenseText` on the rewritten amount-first text, so ambiguity, a future
    date and too many tags behave exactly as they do there.
  - `recordExpense` takes `forms: 'leading' | 'any'`, defaulting to `'leading'`. With `'any'`, a
    `notExpense` from `parseExpenseText` is retried with `readTrailingExpense`.
  - The private-chat text handler and the ambiguity-button handler pass `'any'`. Every other
    caller, and every `expenseShaped` guard, is unchanged.
- **Files touched:** `src/domain/expenseText.ts`, `src/domain/expenseText.test.ts`,
  `src/services/recordExpense.ts`, `src/services/recordExpense.test.ts`,
  `src/bot/handlers/text.ts`, `src/bot/handlers/ambiguous.ts`, `src/bot/bot.test.ts`.
- **Done when:**
  - `Чайник 3200` in the private chat records 320000 RSD «Чайник» and replies with the usual card.
  - `Шкаф 45к дин` records 4500000 RSD «Шкаф». `Ремонт 300 €` records 30000 EUR «Ремонт».
  - `Краска: 2000` records 200000 RSD «Краска».
  - `Чайник 3200 вчера`, sent on 2026-10-07 in Europe/Belgrade, records with `occurred_on`
    2026-10-06.
  - `Лампа 1.500` gets the same two-button ambiguity question as `1.500 лампа`. Tapping the
    thousands reading records 150000 RSD «Лампа».
  - `Чайник 3200 /2`, a two-line text and `сколько ушло за 3?` are not expenses: they get
    today's help reply.
  - `chatterShaped('буду в 7')` and `chatterShaped('Через 10')` are true;
    `chatterShaped('Чайник 3200')` and `chatterShaped('Краска: 2000')` are false.
  - `буду в 7` in the private chat records 700 minor units RSD «буду в»: the private chat doesn't
    use `chatterShaped`.
  - `parseCategoryName('Кофе 2', …)` still returns `ok`.
  - A recurring rule's description «Аренда 2» is still accepted.
  - Redelivering the `Чайник 3200` update leaves one expense.

### Phase 3: Amount-last text in a group asks first
- **Owner skill:** dev
- **What:**
  - Migration `0028_group_asks.sql` adds the `group_asks` table (Data shapes).
  - In a bound group, a text from a person that `parseExpenseText` doesn't read as an expense, but
    `readTrailingExpense` reads as `expense` and `chatterShaped` doesn't flag, gets a reply to that
    message: `groupAskRecord` (copy below), with [Записать] and [Не трата] in one row. It is sent
    silently (`disable_notification`).
  - An `ambiguous`, `futureDate`, `tooManyTags` or `invalid` amount-last read gets no question.
  - The row stores the chat, the message id, the sender's Telegram id, the text, the message's
    date and the question's message id.
  - [Записать] from the sender records through `recordGroupExpense` with `forms: 'any'`, the
    message's date and the source key `tg:<chatId>:<messageId>`. The question is then edited into
    the group card, or deleted when a reaction confirms the expense, as for amount-first text.
  - [Не трата] from the sender deletes the question and the row, with a silent answer.
  - A tap from anyone else gets the `groupAskNotSender` toast.
  - A tap that finds no row (a second tap, a redelivered callback, a question whose cleanup
    delete failed) answers `groupAskAlreadyRecorded` and removes the keyboard when an expense with
    the message's source key exists, and `groupAskGone` and removes the keyboard otherwise.
  - `groupAskProvider` is registered with the scheduler in `src/index.ts`. On each tick it finds
    rows older than 15 minutes. Firing one deletes the row in a transaction and then calls
    `deleteMessage` on the question. A failed delete (already gone, older than 48 hours) is
    logged at debug and dropped.
  - `/delete_account` deletes the user's `group_asks` rows.
  - Copy (illustrative messages-module entries):

    ```ts
    // The question to an amount-last group message (ADR-0046). `when` is set only when the
    // expense's date differs from the message's local date: `Чайник 3200 вчера`.
    groupAskRecord: ({ money, description, when }) =>
      html`Записать <b>${formatMoney(money)}</b> — ${description}${when === undefined ? html`` : html` за ${when}`}?`,
    groupAskRecordButton: 'Записать',
    groupAskNotExpenseButton: 'Не трата',
    groupAskNotSender: 'Ответить может только автор сообщения',
    groupAskAlreadyRecorded: 'Уже записано',
    groupAskGone: 'Вопрос устарел. Отправьте трату ещё раз.',
    ```
- **Files touched:** `src/db/migrations/0028_group_asks.sql`, `src/db/groupAsks.ts`,
  `src/db/groupAsks.test.ts`, `src/services/groupChats.ts`, `src/services/groupChats.test.ts`,
  `src/services/deleteAccount.ts`, `src/services/deleteAccount.test.ts`, `src/bot/group/text.ts`,
  `src/bot/group/ask.ts`, `src/bot/group/index.ts`, `src/bot/group/card.ts`,
  `src/bot/group/group.test.ts`, `src/bot/callbackData.ts`, `src/bot/callbacks.ts`,
  `src/bot/messages.ts`, `src/bot/groupAskProvider.ts`, `src/bot/groupAskProvider.test.ts`,
  `src/bot/testHarness.ts`, `src/index.ts`.
- **Done when:**
  - The sender A of `Чайник 3200` in a bound group gets one reply, «Записать <b>3 200.00 RSD</b> —
    Чайник?». No expense exists yet.
  - `Чайник 3200 вчера`, sent 2026-10-07T10:00Z in a Europe/Belgrade group, gets
    «… — Чайник за 6 октября?», and [Записать] records `occurred_on` 2026-10-06.
  - A taps [Записать] at 10:05Z on a message dated 10:00Z. One expense exists: 320000 RSD,
    `created_by` A, `occurred_at` 10:00Z, source key `tg:<chatId>:<messageId>`. The row is gone.
  - A second [Записать] tap, or a redelivery of the callback, leaves one expense and answers
    «Уже записано».
  - A tap on a question whose row the provider already removed, with no expense recorded, answers
    «Вопрос устарел. Отправьте трату ещё раз.», removes the keyboard and records nothing.
  - B's tap on A's question gets «Ответить может только автор сообщения» and records nothing.
  - [Не трата] deletes the question and the row, and records nothing.
  - `Осталось 2` gets a question, and with no answer nothing is recorded:
    - with the row created at 10:00:00Z, the provider's `due` at 10:14:59Z returns nothing;
    - at 10:15:00Z it returns the row;
    - firing it calls `deleteMessage` with the question's id and removes the row;
    - firing it twice calls `deleteMessage` once.
  - `буду в 7`, `Через 10` and `Будешь в 7?` in the group get no question and store nothing.
  - `3200 чайник` (amount first) in the group records at once, as today, with no question.
  - `Лампа 1.500` in the group gets no question and stores nothing.
  - In an unbound group, `Чайник 3200` gets no question.
  - After A's `/delete_account`, A's pending rows are gone.
  - No log line above debug carries the stored text or the amount.

### Phase 4: Help, README and the group help
- **Owner skill:** dev
- **What:**
  - The private `/help` and the group help name the new shapes, in this copy (illustrative):

    ```ts
    // help, replacing its first line
    html`Чтобы записать трату, отправьте сумму и описание, например «450 кофе» или «Чайник 3200». Валюту можно указать после суммы кодом или знаком: «12,50 EUR такси», «300 € ремонт». Тысячи — буквой к: «45к шкаф».`,
    // groupHelp, replacing its first line
    html`Чтобы записать трату группы, напишите сумму и описание, например «450 кафе». Валюту можно указать после суммы: «12,50 EUR такси» или «300 € ремонт», тысячи — буквой к: «45к шкаф». Трата записывается на ваше имя; узнанную трату я отмечаю реакцией, остальные — карточкой с кнопкой [Удалить].`,
    // groupHelp, a new second line
    html`Если сумма в конце, например «Чайник 3200», я сначала спрошу, записать ли. Ответить может только автор сообщения; без ответа вопрос исчезнет через 15 минут.`,
    ```
  - The README's input section gets the alias table's currencies, the `к` rule, and the two
    chatter rules.
- **Files touched:** `src/bot/messages.ts`, `src/bot/messages.test.ts`, `README.md`.
- **Done when:**
  - The private help contains «300 € ремонт», «45к шкаф» and «Чайник 3200».
  - The group help says amount-last text gets a question that only the author answers, and that
    it disappears after 15 minutes.
  - README's input section names each currency `CURRENCY_ALIASES` covers, with at least one alias
    each.

### Phase 5: Live check
- **Owner skill:** human
- **Blocks merge:** no
- **What:** After deploying, write `300 € ремонт`, `Чайник 3200`, `Осталось 2` and `буду в 7` in
  the private chat and in the family group.
- **Done when:**
  - The private chat records all four. `Осталось 2` and `буду в 7` record 2 and 7 dinars; that is
    expected, since the private chat records amount-last text at once, and [Удалить] removes them.
  - In the group, `Чайник 3200` records after [Записать], and `буду в 7` gets no question.
  - The question to `Осталось 2` disappears by itself within about 16 minutes: 15 minutes plus one
    scheduler tick.

## Data shapes

```ts
// illustrative: src/domain/currencies.ts
// Lower-cased alias -> ISO code. `word`: a separate word after the amount (`300 евро`).
// `glued`: touching the amount, after it or before it (`300€`, `€300`, `2500р`). `both`: either.
type Placement = 'word' | 'glued' | 'both';
export const CURRENCY_ALIASES: ReadonlyArray<{ alias: string; code: CurrencyCode; placement: Placement }> = [
  // EUR
  { alias: '€', code: 'EUR', placement: 'both' }, { alias: 'евро', code: 'EUR', placement: 'word' },
  // USD
  { alias: '$', code: 'USD', placement: 'both' }, { alias: 'долл', code: 'USD', placement: 'word' },
  { alias: 'доллар', code: 'USD', placement: 'word' }, { alias: 'доллара', code: 'USD', placement: 'word' },
  { alias: 'долларов', code: 'USD', placement: 'word' },
  // GBP, JPY
  { alias: '£', code: 'GBP', placement: 'both' }, { alias: '¥', code: 'JPY', placement: 'both' },
  // RUB: a separate `р` stays description
  { alias: '₽', code: 'RUB', placement: 'both' }, { alias: 'р', code: 'RUB', placement: 'glued' },
  { alias: 'р.', code: 'RUB', placement: 'glued' }, { alias: 'руб', code: 'RUB', placement: 'both' },
  { alias: 'руб.', code: 'RUB', placement: 'both' }, { alias: 'рубль', code: 'RUB', placement: 'word' },
  { alias: 'рубля', code: 'RUB', placement: 'word' }, { alias: 'рублей', code: 'RUB', placement: 'word' },
  // RSD
  { alias: 'дин', code: 'RSD', placement: 'both' }, { alias: 'дин.', code: 'RSD', placement: 'both' },
  { alias: 'динар', code: 'RSD', placement: 'word' }, { alias: 'динара', code: 'RSD', placement: 'word' },
  { alias: 'динаров', code: 'RSD', placement: 'word' }, { alias: 'din', code: 'RSD', placement: 'both' },
  { alias: 'din.', code: 'RSD', placement: 'both' }, { alias: 'dinara', code: 'RSD', placement: 'word' },
  // UAH, KZT, TRY, GEL
  { alias: '₴', code: 'UAH', placement: 'both' }, { alias: 'грн', code: 'UAH', placement: 'both' },
  { alias: '₸', code: 'KZT', placement: 'both' }, { alias: 'тенге', code: 'KZT', placement: 'word' },
  { alias: '₺', code: 'TRY', placement: 'both' }, { alias: '₾', code: 'GEL', placement: 'both' },
  { alias: 'лари', code: 'GEL', placement: 'word' },
];
// A glued alias may follow a `к` suffix: `45кдин` is not read, `45к дин` is (suffix, then a word).
```

```sql
-- 0028_group_asks.sql (illustrative)
CREATE TABLE group_asks (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id),
  sender_telegram_id TEXT NOT NULL,
  text TEXT NOT NULL,             -- the message as sent; deleted on answer or expiry
  sent_at TEXT NOT NULL,          -- the message's date, UTC
  ask_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,       -- UTC; expiry is created_at + 15 min
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX group_asks_created ON group_asks(created_at);
```

Callback data: `gask:ok:<messageId>` and `gask:no:<messageId>`. The chat comes from the update. A
message id is at most 10 digits, so the longest is 8 + 10 = 18 bytes.

## Risks & open questions

- **Changed meanings:** a separate currency word after the amount now leaves the description
  (`4500 дин доставка`). A glued `k` turns `4k телевизор` from refused into 4 000. Both are
  covered by tests, so the change is deliberate.
- **Chatter in the private chat:** `буду в 7` sent to the bot records 7 units. The private chat is
  for expenses, and the card has [Удалить]. Phase 5 says so out loud.
- **Privacy:** `group_asks.text` holds group text that may be chatter, for at most 15 minutes plus
  a tick. It never reaches a log above debug, and `/delete_account` removes it.
- **Idempotency:** the question's record uses the message's own source key, so live redelivery,
  double taps and a later import (Plan 0046) can't record it twice.
- **Time:** the expense is dated by the message's date in the ledger's timezone, not by the tap.
  A tap after midnight still records the evening's date.

## What this plan does NOT do

- The chat-history import (Plan 0046).
- Multi-line or comma-separated messages as several expenses, live (Plan 0046 reads them only in
  an import).
- Name prefixes («Ира: …») live.
- Asking in a private chat. Amount-last text records there at once.

## Implementation log

| phase | owner | state | commit |
|---|---|---|---|
| 1: Walking skeleton: `300 € ремонт` records in euros | dev | done | 0fd5d2b |
| 2: Amount-last text in the private chat | dev | done | 340c2a9 |
| 3: Amount-last text in a group asks first | dev | done | 7f3e16b |
| 4: Help, README and the group help | dev | done | 3639052 |
| 5: Live check | human | owed | |

### Notes

- Phase 1: `currencyOfWord(word, placement = 'word')` takes a second argument, `'word'` or
  `'glued'`, so a glued-only alias (`р`) is not read as a separate word. `currencies.ts` also
  exports `GLUED_ALIASES`, the glued aliases longest first, which the parser scans.
- Phase 2: `chatterShaped(text, today?)` takes an optional `today`, so a trailing date word
  (`буду в 7 вчера`) locates the amount the same way `readTrailingExpense` does.
- Phase 2: amount-last text splits at the leftmost amount-shaped word that only a currency word,
  tags and a date word follow (`Чайник 3200 25.09` is dated, not 25.09 RSD). A bare digit word
  right before the amount makes the text unreadable (`Чайник 3 200` is not recorded as 200
  «Чайник 3»). The plan names neither rule.
- Phase 2: the bot test `answers non-expense text with the help hint` sent `coffee 450`, which now
  records in the private chat. It sends `coffee later` instead.
- Phase 2, done-when «A recurring rule's description «Аренда 2» is still accepted»: the recurring
  service has no rule-description guard. Its one `expenseShaped` guard is the reminder text
  (`answerReminderText`), which refuses only an `expense`/`ambiguous` parse. The test asserts
  `parseExpenseText('Аренда 2')` is `notExpense`, in `expenseText.test.ts`, because
  `recurring.test.ts` is not in the phase's files. `parseCategoryName('Кофе 2')` is tested there
  too.
- Phase 3: `src/bot/callbacks.ts`, `src/bot/group/card.ts` and `src/bot/testHarness.ts` are
  unchanged. The group tests give the question a message id with the harness's existing
  `withMessageIds`.
- Phase 3: `groupAskRecord` takes `{ money, description, date, sentOn }` and builds the «за …»
  part itself, the same way `groupExpenseLine` does, in place of the plan's `when` argument.
- Phase 3: the asking code is `askGroupExpense` in `src/bot/group/ask.ts`, called from
  `group/text.ts`. The service side is `groupAskFor`, `saveGroupAsk`, `answerGroupAsk`,
  `dueGroupAsks` and `expireGroupAsk` in `groupChats.ts`. A message that already has a row, or
  already has an expense under its source key, gets no second question.
- Phase 3, done-when «After A's `/delete_account`, A's pending rows are gone»: tested at the
  service level in `deleteAccount.test.ts`, not through the bot.
- Phase 4: the README gets three rows in the private table, one in the group table, and a new
  `### Currency words` section after `### Amount rules` with the alias table and the two chatter
  rules. `README.md` was not prettier-clean before this phase and is left unformatted.
- Followup, not acted on: the test harness's fake answers every `sendMessage` with `true`, so the
  question's `message_id` is undefined in any test bot without `withMessageIds`. A group test that
  sends amount-last text from a person to a bound group without it would fail on the
  `group_asks` insert. No current test does this.

### Close triggers

- Phases 1 to 4 (`dev`) are done in 0fd5d2b, 340c2a9, 7f3e16b and 3639052. Phase 5 (`human`,
  `Blocks merge: no`) has not started.
- Gate on the tip (3639052):
  - `pnpm typecheck` exited 0.
  - `pnpm lint` exited 0.
  - `pnpm test` exited 0, with 144 files and 2149 tests passed.
  - `pnpm build` exited 0.
  - `node scripts/check-doc-links.mjs` exited 0, with 359 relative links resolving.
- New migration: `src/db/migrations/0028_group_asks.sql` (the `group_asks` table and its
  `created_at` index).
- New files: `src/db/groupAsks.ts`, `src/bot/group/ask.ts`, `src/bot/groupAskProvider.ts`, and
  tests `src/domain/currencies.test.ts`, `src/db/groupAsks.test.ts`,
  `src/bot/groupAskProvider.test.ts`.
- New scheduler provider: `groupAsk`, registered in `src/index.ts` after `summary`.
- New callback data: `gask:ok:<messageId>` and `gask:no:<messageId>` (`GROUP_ASK`).
- New messages: `groupAskRecord`, `groupAskRecordButton`, `groupAskNotExpenseButton`,
  `groupAskNotSender`, `groupAskAlreadyRecorded`, `groupAskGone`. Changed: `help` (first line)
  and `groupHelp` (first line, plus a new second line).
- No dependency change.

## Close review

Closed 2026-10-08 on review round 1 (tip fa7e58d). The minor and the nit are code changes, so both
stay open as followups below. Phase 5 (`human`, the live check, `Blocks merge: no`) stays owed
after deploy. No earlier round raised a finding.

### Plan 0045 close review, round 1 (tip fa7e58d)

**Verdict:** Clean. Phases 1 to 4 do what the plan and ADR-0046 say, and every named done-when
has a test whose assertion defends it. One minor (amount-last text whose description starts with a
currency word picks up that currency) and one nit go to followups. Neither blocks the close.

#### Gate (run in this session on the lane at fa7e58d)

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm test`: exit 0, 144 files and 2149 tests passed.
- `node scripts/check-doc-links.mjs`: exit 0, 359 relative links resolve.

#### Lens 1: alignment

- Phases 1 to 4 (`dev`) landed in 0fd5d2b, 340c2a9, 7f3e16b and 3639052. Phase 5 (`human`,
  `Blocks merge: no`) is owed after deploy. Each phase has exactly one in-vocabulary owner tag.
- Assertions read:
  - Phase 1: `expenseText.test.ts` covers every listed shape with `toStrictEqual`: amount, currency,
    description and empty tags. That includes `1.500к` → 150000 with no ambiguity, JPY `1,5к` →
    1500, `500 к чаю` and `500 р кофе`, and `500кг картошки` → `invalid`, which is what the old
    parser also returned. `bot.test.ts` checks the stored row (30000 EUR) and the card's
    «300.00 EUR».
  - Phase 2: `bot.test.ts` covers `Чайник 3200` (row plus the exact card call), `Шкаф 45к дин`,
    `Ремонт 300 €`, `Краска: 2000` and `буду в 7` (700 «буду в»). It also covers `вчера` →
    `occurred_on` 2026-10-06, `/2`, the two-line text and `?` → help reply plus zero rows,
    redelivery → one row, and `Лампа 1.500` (the same calls as `1.500 лампа`, and the tap records
    150000 «Лампа»). `chatterShaped` is tested on all four named strings.
  - Phase 3: `group.test.ts` matches the question call exactly: silent, a reply, both buttons and
    their `gask:` data. It also checks the stored row, the date line «за 6 октября», the
    created_by/occurred_at/source_key row, the second tap plus a double redelivery → «Уже записано»
    ×3 with one expense, the expired row → «Вопрос устарел…» plus the keyboard removed, B's taps
    → the toast with the row kept, and [Не трата] → deleteMessage with the row gone. The no-question
    cases are covered, as are amount-first recording at once, the unbound group and the log
    privacy check. `groupAskProvider.test.ts` covers the due boundary at 10:14:59 and 10:15:00,
    one deleteMessage across two fires, and a refused delete swallowed under `runTick`.
    `deleteAccount.test.ts` checks that only the sender's rows go.
  - Phase 4: `messages.test.ts` checks the three help examples and the group-help line verbatim,
    with the TTL derived from `GROUP_ASK_TTL_MS`. README's `### Currency words` table lists every
    code in `CURRENCY_ALIASES` with at least one alias.
- The implementation log records its deviations: `currencyOfWord`'s placement argument,
  `chatterShaped`'s `today`, the leftmost-split and digit-before-amount rules, `groupAskRecord`'s
  argument shape, the unchanged `callbacks.ts`/`card.ts`/`testHarness.ts`, and the
  `/delete_account` and «Аренда 2» done-whens tested at the service and domain level. Each is
  reasonable and consistent with the plan's intent. The «Аренда 2» proxy is sound because the
  recurring guard is `parseExpenseText`, which `forms` never reaches.
- ADR-0046 is honoured: `parseExpenseText` stays amount-first, the guards are unchanged,
  `readTrailingExpense` is opt-in through `forms: 'any'` (the private text handler, the ambiguity
  handler, and the group answer only), `?` is refused in every chat, and `chatterShaped` is used
  only in the group. No ADR is silently reversed.

#### Lens 2: layering

- Domain (`currencies.ts`, `expenseText.ts`) imports nothing from db or grammY. SQL lives in
  `src/db/groupAsks.ts`. grammY is imported only under `src/bot/`. Copy lives in `messages.ts`.
- `group_asks` is keyed by chat and message, and stores the sender's Telegram id as data, not as a
  user key. Its migration comment says why.

#### Lens 3: correctness

- Money: `к` is computed on digit strings (`thousandsUnits`) and goes through `parseAmount`. No
  float, `parseFloat` or `toFixed` was added.
- Time: the group expense is dated by `message.date` through `sentAt`. `sentOn` is the ledger's
  local date. The TTL compares against the scheduler's injected `now`.
- Idempotency: deleting the row claims the answer inside the transaction that records under
  `tg:<chat>:<message>`. A redelivered text finds the row or the expense and asks no second time.
  `expireGroupAsk` claims before `deleteMessage`.
- Privacy: info-level log lines carry only `ledgerId`, and the group test asserts that no text or
  amount reaches them.
- Telegram limits: `gask:ok:<10 digits>` is at most 18 bytes, and `assertCallbackData` guards it.

#### Findings

**blocker:** none. **major:** none.

**minor 1. Amount-last text whose description starts with a currency word records in that
currency.** (open)
- *What:* `readTrailingExpense` rewrites `<description> <amount>` to `<amount> <description>`
  and hands the result to `parseExpenseText`. That parser reads the first word after the amount
  as a currency word whenever the amount has no glued alias. So `Евро кубок 300` becomes
  `300 Евро кубок` and parses as 300.00 EUR «кубок». `Gel лак 1500` parses as 1500.00 GEL
  «лак», because `GEL` is an ISO code and `currencyOfWord` reads it in any case. Neither text
  names a currency after the amount.
- *Where:* `src/domain/expenseText.ts:734-741` (the rewrite in `readTrailingExpense`).
- *Why it matters:* this is the same class of bug the plan exists to fix: the wrong currency
  on a recorded expense. In a private chat it records at once. The card shows the currency, so
  it isn't fully silent, but the user has to catch it. The group question shows it before
  recording. The trigger is rare, so this is not a blocker.
- *Suggested fix:* when `parts.currency` is undefined and the amount word carries no glued
  alias, put the ledger's default ISO code into the rewrite: `[amount, defaultCurrency,
  ...description, ...]`. The description's first word is then never read as a currency. With
  a glued alias (`300€`), `parseExpenseText` already skips the word-currency read, so leave the
  rewrite as is. Test: `readTrailingExpense('Евро кубок 300', 'RSD')` gives 30000 RSD
  «Евро кубок», and `'Gel лак 1500'` gives 150000 RSD «Gel лак».

**nit 1. A redelivered amount-last group message re-asks after [Не трата].** (open)
- *What:* [Не трата] deletes the row and no expense exists. If Telegram then redelivers the
  original text update, `groupAskFor` finds neither and sends a second question.
- *Where:* `src/services/groupChats.ts:244-247`.
- *Why it matters:* this needs a redelivery after a dismissal, which is rare, and the cost is
  one extra question that expires by itself.
- *Suggested fix:* none needed now. If it shows up, keep a dismissed row (a `dismissed_at`
  column) until expiry instead of deleting it.

#### Bookkeeping owed at close

- Flip plan 0045 to `done` and `git mv` it to `docs/plans/done/`. Repair the inbound link from
  ADR-0046 and the outbound `../adrs/` links, then run `node scripts/check-doc-links.mjs`.
- Accept ADR-0046 (`proposed` → `accepted`) and refresh its row in `docs/adrs/README.md`.
- `docs/plans/README.md`: the 0045 row still reads `approved`. Move it to recently closed.
- Version: minor bump (a feature plan: new input shapes, a group question, migration 0028), with a
  `CHANGELOG.md` entry and a `versionAnnouncements` entry (ADR-0013).
- Phase 5 (human live check) stays owed after deploy.
- Followups for `## Followups`: minor 1 above, nit 1 above, and the log's harness note
  (`sendMessage` returning `true` leaves the question's `message_id` undefined without
  `withMessageIds`).
- `CLAUDE.md`'s "Where things live" needs no change, because no new top-level module was added.
  `.env.example` needs no change, because there is no new config.

## Followups

- Review minor 1: `readTrailingExpense` lets a description's first word name the currency
  (`Евро кубок 300` records 300.00 EUR «кубок»). Put the default ISO code into the rewrite when the
  amount has no glued alias.
- Review nit 1: a redelivered amount-last group message re-asks after [Не трата]. Keep a dismissed
  row until expiry if it shows up.
- The test harness's fake answers every `sendMessage` with `true`, so the question's `message_id`
  is undefined in a test bot without `withMessageIds`.
