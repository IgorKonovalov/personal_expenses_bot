# ADR-0030: Debts are signed operations balanced per person and currency; group settle-up splits equally per currency

> **Status:** accepted
> **Date:** 2026-10-01
> **Related plan(s):** Plan 0013 ([0013-debts.md](../plans/done/0013-debts.md))

## Context

Plan 0013 adds two related things. A user's **personal debts**: money lent to or borrowed from a
named person, repaid in full or in part. And a **group settle-up**: who owes whom inside a shared
ledger, computed from the expenses each member paid. Neither is spending, so both stay out of
every total and budget.

ADR-0003 stores every amount in its original currency, and ZenMoney's rule is that a debt closes
in the currency it opened in. If debts were converted, a settled 20 EUR loan would reopen as a few
dinars of difference the day the rate moved. The same drift would hit a group: old expenses at
old rates against new transfers at new rates, so a settled group would never read zero.

A group ledger's membership is implicit: a person becomes a member when the bot first sees them
record (`joinMember`). Members can join long after the group started.

## Decision

**Personal debts** are rows in `debt_ops`: one operation each (`lend`, `borrow`, `repaid_to_me`
or `i_repaid`) with a positive amount, a currency, the person and a date. A person's balance in
a currency is the sum of `lend` and `i_repaid` minus the sum of `borrow` and `repaid_to_me`.
Positive means they owe me. Balances are never converted and never netted across currencies. A
repayment picks one of the person's non-zero currencies. People are a per-user list of names
(`debt_people`), created on first use. Undo is a soft delete of the operation.

**Group settle-up** splits each live group expense equally among the members who had joined by
the expense's local date (`ledger_members.joined_at`). The payer's share absorbs the indivisible
remainder: with amount A and n members, each other member owes `floor(A / n)` to the payer. A
recorded transfer (`ledger_transfers`) from member X to member Y moves X's balance up and Y's down
by its amount, in its currency. `/settle` shows each currency's balances and a greedy list of
transfers (largest debtor pays largest creditor), at most n − 1 per currency.

In a sealed personal ledger (ADR-0020), debt amounts, currencies and people's names are sealed
to that ledger's key like expenses. Unlike expenses, recording a debt needs the person list,
so debts are both recorded and read only while unlocked.

## Consequences

### Positive
- A debt can't drift: 20 EUR lent and 20 EUR repaid is exactly zero, forever.
- Partial repayments, several currencies with one person, and undo all fall out of one sum over
  one table.
- Settle-up needs no stored balances. Editing or deleting a group expense corrects it
  automatically.

### Negative
- A person owing in two currencies sees two balances and settles twice. That's deliberate, and it
  can be explained but not hidden.
- No per-loan history: "the 5000 from March" isn't an object, just part of a sum.
- Equal shares only. A group whose members share unequally can't express that, so they record
  transfers by hand.
- A member who never interacts with the bot in the group isn't counted. Joining is explicit
  (Plan 0013).
- The greedy transfer list is not always the true minimum. It is at most n − 1 transfers per
  currency, which for a family-sized group is the minimum in practice.

## Alternatives considered

### Alternative A: debt objects with attached repayments
Each loan is an object with a principal and a status, and repayments reference a loan. This
mirrors ZenMoney and keeps per-loan history. It lost because two open loans to one person in one
currency force a "which loan?" step on every repayment, for history the user didn't ask for.

### Alternative B: settle-up converted into the ledger currency
One number per member, at the NBS rate (ADR-0022). It lost to rate drift: a group that settles
exactly today reads a few units off tomorrow, and the bot would invent debts nobody has.

### Alternative C: settle-up per period, with no recorded transfers
`/settle` for this month only. It lost because the bot couldn't tell whether anyone paid, so last
month's imbalance would vanish at midnight on the 1st.
