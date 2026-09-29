# NNNN: <short title>

> **Status:** draft | approved | in-progress | done | abandoned
> **Created:** YYYY-MM-DD
> **Related ADRs:** ADR-NNNN (link), or none

## TL;DR

One paragraph: what we're building, why, and the first behavior the user will see in the chat.
A reader who reads only this can restate the decision in one sentence.

## Context & problem

What forces drove this. Describe the *problem*, not the chosen solution.

## Decision

The chosen approach in one paragraph, active voice. Name the rejected options in one sentence
each: "We rejected B because …".

## Architecture diagram

```mermaid
flowchart LR
    %% Replace with a real diagram. Use subgraphs for layer boundaries:
    %% Telegram / bot adapter / services / domain / db.
    A[Telegram update] --> B[handler]
```

## Implementation phases

Each phase ships as its own commit. `dev` implements all phases in one session with no review
between phases. The architect reviews once at the end, in a fresh session. **Phase 1 is a walking
skeleton**, something observable in Telegram, not plumbing.

Every phase carries exactly one `**Owner skill:**`: `dev` or `human`.

### Phase 1: <name>
- **Owner skill:** dev
- **What:** One sentence on what this phase produces.
- **Files touched:** `src/domain/money.ts`, `src/domain/money.test.ts`, …
- **Done when:** A concrete behavioral acceptance. For tests, state the claim they defend
  ("`12,50 eur` parses to `{ amount_minor: 1250, currency: 'EUR' }`"), not "tests pass". Every
  numeric value is worked out, not guessed.

### Phase 2: <name>
…

## Data shapes

New types, tables and callback-data formats, pinned down. Short and labelled illustrative.

```ts
// illustrative
interface Expense {
  id: string;
  userId: string;
  amountMinor: number; // integer
  currency: string; // ISO-4217
  categoryId: string;
  occurredOn: string; // YYYY-MM-DD in the user's timezone
  createdAt: string; // UTC instant
}
```

## Risks & open questions

What could go wrong, and what we'd do about it. Call out money, time, idempotency and privacy
hazards explicitly.

## What this plan does NOT do

Scope cuts, naming future plans where possible.

## Implementation log

> Written by `dev`: one row per phase as its commit lands, then the close block. **The phases
> above are the contract. This section records what happened.** Observations, never conclusions:
> no pass list, no self-assessment. Deviations and unmet done-whens are **always** disclosed.
> Keep it shorter than `## Implementation phases`.

| phase | owner | state | commit |
|---|---|---|---|
| 1: <name> | dev | not started | |

### Notes

_(Deviations from the plan, with the commit, stated without justification. Done-whens not
satisfiable as stated, and what was done instead. Followups noticed and not acted on. One line
each. Empty is fine.)_

### Close triggers

_(Facts for the architect. No recommendations, and no suggested version bump.)_

- **What shipped:** feature / fix-only / docs-chore-only
- **User-visible surface changed:** commands, messages, config/env keys, schema migrations (list them, or none)
- **Gate at the tip:** the commands run (typecheck, lint, full test suite), exit codes, test counts
- **Outstanding `human` phases:** which, or none

## Followups

A list. Empty at draft time is fine.
