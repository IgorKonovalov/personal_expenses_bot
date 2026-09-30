# ADR-0010: Approved plans run under a conductor forked from Ritmolux, on trial before any package

> **Status:** proposed
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0006](../plans/0006-conductor-trial.md)

## Context

Every plan here costs the owner the same handoffs with no judgement in them: typing "go" to a `dev`
session for a plan already marked `approved`, carrying `dev`'s pointer into a fresh `/architect`
session, and running the close. On 2026-09-29 five plans (0002 to 0005, then 0007) were approved in one sitting.
At that pace the handoffs, not the work, decide how fast plans land.

The sibling Ritmolux project already built a driver for this loop: `tools/conductor/` there, decided
in its ADR-0205. It is a Node program that takes approved plans off a committed queue and runs each
one in a git worktree lane. It starts a fresh headless `claude -p` session for every same-owner run of
phases, checks each session's claims against `git`, runs its own gate, starts a fresh `architect`
process to review and a second one to close, then fast-forwards `main`. It never pushes. Anything it
can't decide parks the plan. It has 147 commits and about 20 follow-up ADRs of hardening behind it,
and it runs nightly on this machine against the installed CLI (2.1.283 is on its verified list).

It is not drop-in. It imports two Ritmolux scripts (`scripts/gates.manifest.mjs`,
`scripts/check-upstream-ci.mjs`), hardcodes a cargo and studio gate, and keys a suite lock and a
green-suite record to `cargo nextest run --workspace`. Its plan reader expects `# NNNN — Title`
where our plans read `# NNNN: Title`. Its owner vocabulary includes `studio-builder`, its close
verifies an annotated tag that our close ceremony never makes, and its prompts are written for Rust.

The owner wants to find out whether the model works here before deciding whether it becomes a
shared package with the harness (hooks, settings, prompts) attached. That decision is explicitly
deferred.

## Decision

> We fork Ritmolux's conductor into `tools/conductor/` and adapt it to this repository. The code that
> differs between projects goes into one adapter module. The conductor's instructions to its
> sessions live in its own prompt files. We then run it on Plans 0007 and 0003 as a trial, and the
> owner delivers a go/no-go verdict on the model.

- **For a plan the conductor runs, approval is the "go".** A plan is eligible when its `Status:`
  reads `approved` and `tools/conductor/queue.json` lists it. The architect owns the queue's order.
  Outside the conductor, the manual loop in `CLAUDE.md` is unchanged: a human-started `dev` still
  restates the plan and waits.
- **A fresh session means a separate process.** The reviewer is started with the plan path and the
  lane and nothing else. That is the property the manual close review exists for, and a new
  `claude -p` process has it by construction.
- **Only a clean verdict merges** (no blockers, no majors). Blockers and majors go to a fresh `dev`
  fix session, and after two fix rounds that still fail, the plan parks. Every judgement the conductor
  can't make parks the plan, and every push stays the owner's.
- **Project specifics live in one adapter module** (`tools/conductor/project.mjs`): the gate
  command list, the owner vocabulary, the plan-title pattern, the lane directory prefix and the
  dependency install for a new lane. The engine imports nothing from outside `tools/conductor/`.
  The adapter's size is itself trial evidence for the later package decision.
- **Conductor-mode instructions live in `tools/conductor/prompts/`, not in the skills.** Ritmolux
  puts an 80-line `## Conductor mode` section into each skill. Here each skill gets a short pointer
  that hands control to the prompt, so the skills stay lean and the harness stays in one directory.
- **Ritmolux's slow-suite machinery is dropped, not ported.** That means the suite lock, the
  green-suite record and the studio install. Our Vitest suite reruns at every gate. The annotated-tag
  check goes too: a conductor close does what our close ceremony does (version bump plus
  `CHANGELOG.md`) and no more.

## Consequences

### Positive
- An approved plan with no `human` phase goes from the queue to a local `main` with no owner action.
  Plans 0007, 0003, 0004 and 0005 are all like that.
- The review can't be handed a summary, because the conductor has none to hand. A manual close was
  only as fresh as the owner's discipline about what they pasted.
- The trial produces the evidence the package decision needs: how much code turned out to be
  project-specific (the adapter), which parks happened, spend per plan, and how many conductor fixes
  the trial forced.

### Negative
- **The owner no longer reads a verdict before it takes effect.** A clean review merges unread into
  the local `main`. The push is the last checkpoint, and a bad merge is undone with a new commit.
- **A model grades a model**, up to twice per plan with nobody reading. Two fix rounds is a cap, not
  a guarantee.
- **The tool is larger than the product.** The conductor is about 5.3k lines of engine plus tests and
  prompts, against about 2.4k lines of TypeScript in `src/`. We maintain it, and it drifts with the
  CLI it drives.
- **The fork drifts from Ritmolux.** Fixes made there don't arrive here until someone ports them.
  Deferring the package decision prolongs this. The trial is meant to be short for that reason.
- **The main checkout must stay clean while a run is live**, because a dirty checkout refuses the
  fast-forward and parks every close. Owner work moves to a worktree of its own.
- **It spends unattended.** Per-step and per-run caps live in a gitignored `local.json`, which the
  conductor refuses to start without.

## Alternatives considered

### Alternative A: Keep the manual loop
No new tool and no spend nobody watches. Rejected for this trial because the handoffs carry no
judgement that the plan approval didn't already carry. The owner's call is to measure the automated
loop rather than argue about it. If the verdict is no-go, this is what we go back to.

### Alternative B: Extract a shared package first, then adopt it here and in Ritmolux
The end state the owner has in mind. Rejected as the first step because designing a package boundary
before a second project has used the tool means guessing where the seam goes. The trial's adapter
module finds the seam empirically. Where the package lives and how it's pinned is decided after the
verdict, in its own ADR.

### Alternative C: Write a minimal driver from scratch
Smaller and ours. Rejected because it throws away lessons that cost Ritmolux real runs. For example:
a headless session can't write under `.claude/`, a backgrounded command dies when the turn ends, the
CLI's stream needs parsing, and a claim has to be checked against `git`. Each of those would be
relearned here, one bad night at a time.

### Alternative D: Point Ritmolux's copy at this repository
No fork at all. Rejected because its engine resolves imports relative to Ritmolux's own tree
(`../../../scripts/...`), and running it against another repository would make every Ritmolux
conductor change a potential break here, with nothing to catch it.
