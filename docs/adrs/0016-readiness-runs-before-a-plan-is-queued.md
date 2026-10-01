# ADR-0016: The readiness check runs before a plan is queued, and `run` refuses a plan without one

> **Status:** accepted
> **Date:** 2026-09-30
> **Related plan(s):** [Plan 0010](../plans/done/0010-conductor-followups-readiness-at-queue-time.md)

## Context

The conductor (ADR-0010) runs a read-only readiness session before a plan's first implement
session. The session grades the plan against itself and the tree: each phase's *What*, *Files
touched* and *Done when* agree, and every seam a phase relies on is in some phase's *Files
touched*. So far it has fired once per affected plan: 0007 and 0003 in the trial, 0004 on the
2026-09-30 evening run. Each park was a real gap, most often a *Files touched* that left out a
module the phase has to extend (`tools/conductor/FOLLOWUPS.md` H3, F1).

The check works. It just runs at the wrong time. By run time, the architect session that wrote
the plan is closed, the lane already exists, and the fix costs a hand plan amendment plus a hand
fast-forward of the lane (F2). The trial's followup, "re-check queued plans after each close", was
a practice with nothing enforcing it, and it was not followed.

## Decision

A new command, `conductor.mjs ready NNNN`, runs the same readiness session against `main` in a
throwaway detached worktree. It records `{ hash, main, at }` as the plan's readiness record in
conductor state, or prints the park detail and records nothing. `hash` is `planContractHash`,
which from now on also ignores the plan's `> **Status:**` line, so a plan checked as `draft` stays
checked once it's flipped to `approved`. The architect runs `ready` before approving a plan for the
queue. It fixes a park in the same session, while the plan's context is still live.

`run`'s preflight refuses a queued plan that hasn't started and has no readiness record, or whose
record's `hash` no longer matches the plan. The error names the plan and the `ready` command to
run. At run time, the lane keeps its readiness session as a safety net, but runs it only when the
plan's hash or the `main` tip it merged differs from the record. A plan queued `after` another
therefore gets re-checked against the tree its dependency left.

## Consequences

### Positive
- A plan gap surfaces in the planning session that can fix it, not in an unattended run.
- "Re-check after a close" becomes mechanical: a moved `main` re-runs readiness in the lane.
- It adds no new judgement. It's the existing readiness prompt and session, run earlier.

### Negative
- Queuing takes one more command, and readiness now costs money before a run starts. A plan
  queued behind a dependency pays for readiness twice.
- Readiness records live in gitignored conductor state. On a fresh clone, or after state is
  wiped, every queued plan needs `ready` again.
- `run` can refuse to start over a one-character plan edit. That's intended, since an edit is
  what makes the old verdict stale.

## Alternatives considered

### Alternative A: let the run-time readiness session amend *Files touched* itself

This removes the hand work for the common gap entirely. It lost because it has a headless session
edit an approved plan, with no owner reading the change. Verifying mechanically that "only *Files
touched* lines changed" also doesn't prove that the new files are within the plan's scope.

### Alternative B: a deterministic symbol script

A script would pull backticked symbols from each phase, `git grep` their defining files, and flag
any not in *Files touched*. There's no LLM spend, but the check is heuristic. Backticked names in
this repo mix types, copy keys, commands and file paths, so the noise would train the architect to
ignore it. The readiness prompt already does this check with judgement.
