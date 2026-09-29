# ADR-NNNN: <decision title>

> **Status:** proposed | accepted | superseded by ADR-NNNN
> **Date:** YYYY-MM-DD
> **Related plan(s):** Plan NNNN (link), if any

## Context

The forces at play, and why this is a *decision* that could reasonably go either way. Two to
four short paragraphs of concrete facts: a Telegram limit, a data-shape constraint, an
operational cost, a lesson from the sibling project.

## Decision

One paragraph, active voice, present tense.

> We store every amount as an integer count of the currency's minor units, with an ISO-4217 code
> alongside it, and do all arithmetic in one money module.

Capture nuance ("X unless Y") here, not in a footnote.

## Consequences

### Positive
- What this unlocks.

### Negative
- What it costs. **This is the most important section, so be honest.**

## Alternatives considered

One paragraph each: what it was, and the one decisive reason it lost. More than three usually
means padding.

### Alternative A: <name>

### Alternative B: <name>

## Outcome

_(Added only at acceptance if implementation falsified something above. Dated. Never rewrite the
body.)_
