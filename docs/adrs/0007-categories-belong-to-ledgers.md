# ADR-0007: Categories belong to ledgers, seeded from a preset and editable

> **Status:** accepted (2026-09-30)
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0003](../plans/done/0003-categories.md)

## Context

Every summary beyond "total per currency" needs a category on each expense. A first-time user
shouldn't have to build a category list before recording `450 кофе`. A family also names things
its own way ("Кружки детей", "Дача"), and a fixed list forces those into «Другое».

Expenses belong to ledgers (ADR-0002), and a shared ledger's members have to see the same
categories for its summaries to mean anything.

Category ids go into `callback_data`, which Telegram caps at 64 bytes. An expense UUID (36) plus a
category UUID (36) plus a prefix doesn't fit.

## Decision

A `categories` table belongs to a **ledger**. Each new ledger is seeded from a preset list in
`src/domain/categoryPresets.ts`. Each preset has a stable `preset_key`, which the keyword rules
in ADR-0008 target, so a rename keeps its rules. Members can add, rename and **archive** a
category. Archiving hides it from the picker and keeps it on past expenses and in summaries.
Categories are never deleted, so no expense is orphaned. The preset `other` («Другое») can't be
archived, because it's the fallback. Names are unique per ledger by a case-folded
`name_key` computed in the domain. SQLite's `NOCASE` folds ASCII only, not Cyrillic. Adding a name
that matches an archived category restores that category.

Categories use an `INTEGER PRIMARY KEY`, unlike the UUID tables. That keeps
`exp:setcat:<expenseUuid>:<categoryId>` well under 64 bytes. Category ids are internal and never
shown to users.

`expenses.category_id` is nullable. Rows recorded before this ADR stay `NULL` and show as
«Без категории». Every new expense gets a category.

## Consequences

### Positive
- Works on the first message with no setup, and adapts to how a family actually spends.
- Shared ledgers (a later plan) share categories with no extra design.
- Archive-not-delete means history and summaries never lose a category.

### Negative
- Categories need a management UI (`/categories`) and a text-input step, which needs persisted
  flow sessions (ADR-0009).
- Two id styles in the schema (UUID and integer). This is tolerated because category ids never
  leave the process except in `callback_data`.
- Renamed and custom categories make the preset keyword rules partial: a custom category is
  reached only through learning (ADR-0008) or the picker.

## Alternatives considered

### Alternative A: One fixed list in code
It needs no management UI and no table. It lost because every family-specific category becomes
«Другое» forever, and adding one needs a deploy.

### Alternative B: Fully user-defined, starting empty
It's maximally flexible. It lost on first-run experience, because the first expense has nowhere to
go and summaries stay useless until the user builds a list.

### Alternative C: Categories owned by the user, not the ledger
It's simpler for one person. It lost because two members of a shared ledger would categorise the
same book with different lists, so the ledger's summary would mix both.
