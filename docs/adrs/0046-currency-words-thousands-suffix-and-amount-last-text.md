# ADR-0046: Expense text accepts currency words and a thousands suffix; amount-last text records in a private chat and is asked about in a group

> **Status:** accepted
> **Date:** 2026-10-07
> **Related plan(s):** [Plan 0045](../plans/done/0045-currency-words-and-amount-last-text.md)

## Context

The expense parser (`parseExpenseText`, ADR-0004) reads `<amount> [ISO code] <description>`. The
currency is recognised only as a three-letter Latin code. Real family-chat text uses other shapes:
a currency symbol or word (`300 €`, `4500 динар`, `2500р`), a thousands suffix (`45к`), and the
amount at the end (`Чайник 3200`). Today `300 € ремонт` records 300 in the ledger's default
currency with the description «€ ремонт». That is wrong money, recorded silently. `45к` is refused
as invalid. `Чайник 3200` is not an expense at all.

The amount-last shape is the risky one. With privacy mode off (ADR-0014), every group message
reaches the parser. Ordinary chat like «буду в 7» or «осталось 2» ends in a number. In a private
chat the same text has no other meaning: a text that isn't an expense gets the help reply.

`parseExpenseText` is also a guard. A category name, a recurring rule's description, a debt
person's name and a budget prompt are refused when the parser reads them as an expense
(`expenseShaped`). If the parser itself accepted amount-last text, names like «Кофе 2» would
start being refused.

## Decision

We extend the amount-first form and keep it the only form `parseExpenseText` reads.

- **Currency words and symbols.** A word right after the amount, or a symbol or a short suffix
  glued to it (`300€`, `2500р`), names the currency from a fixed alias table (Plan 0045's data
  shapes). The word leaves the description.
- **A thousands suffix.** `к` or `k` glued to the amount multiplies it by 1000. With the suffix, a
  `.` or `,` is always a decimal point (`1,5к` is 1 500), so there is no ambiguity question.

The amount-last form (`<description> <amount>[к] [currency] [#tags] [date]`) is a second reader,
`readTrailingExpense`. It rewrites the text into the amount-first form and parses that.
`recordExpense` uses it only when its caller asks for it:

- **In a private chat,** amount-last text records like any expense.
- **In a group,** amount-last text records nothing at once. The bot replies to it with one
  question, «Записать 3 200.00 RSD — Чайник?», and two buttons, [Записать] and [Не трата]. Only the
  sender can answer. The question is deleted when it is answered with [Не трата], or after 15 minutes
  with no answer. [Записать] records the expense with the message's own date and source key, so a
  second tap records nothing.

Two rules keep chatter out. Text with a `?` is never amount-last, in any chat, because it is a
question. In a group, amount-last text gets no question when the word before the amount is a
preposition of time or place («в, к, до, через, с, по, около, после»): «буду в 7» stays chatter.
This is a heuristic, and it is labelled as one in code. Amount-first text is unaffected.

The guards that call `parseExpenseText` keep today's meaning.

## Consequences

### Positive
- `300 € ремонт` stops recording the wrong currency.
- The way the family already writes (`Чайник 3200`, `Шкаф 45к дин`) works in a private chat, and
  takes one tap in the group.
- The chat-history import (ADR-0047) reuses the same readers, so live and imported text agree.

### Negative
- An amount-last message in the group costs a tap, and chatter ending in a number gets a question
  that sits in the chat for up to 15 minutes.
- The group question needs storage. A small table holds the message's text until the question is
  answered or deleted.
- A few texts change meaning. `4500 дин доставка` now records «доставка» where it recorded
  «дин доставка». `4k телевизор` now records 4 000 «телевизор» where it was refused. A separate
  `р` stays description: `500 р кофе` still records 500 «р кофе» in the default currency, and
  only a glued `2500р` reads as roubles.
- In a private chat, amount-last chatter records. «буду в 7» sent to the bot becomes 7 units,
  removed with the card's [Удалить].

## Alternatives considered

### Alternative A: record amount-last group text at once, undo if wrong
This is the same as amount-first text: a reaction, and the card's delete button. It was rejected
because chatter becomes money in a shared ledger that someone has to notice and delete. A question
costs one tap, but a wrong record costs a cleanup.

### Alternative B: amount-last only with a currency marker or `к`
`Чайник 3200 дин` would record at once, and a bare `Чайник 3200` would stay chatter. There would
be no false records and no questions. It was rejected because the bare form is the one the family
actually writes, and it would keep failing silently.

### Alternative C: amount-last in the private chat only
The group keeps the strict form. This is the simplest option, but it was rejected because the
group is where the backlog was written, and where people keep writing that way.

### Alternative D: `parseExpenseText` accepts amount-last text itself
That is one reader instead of two. It was rejected because every `expenseShaped` guard would start
refusing names that end in a number.
