# The conductor

A fork of Ritmolux's `tools/conductor/` at Ritmolux commit `b0c0aa42` (the last commit that touched
it; Ritmolux `main` was `22a665a4`, with the same tree), adapted to this repository and on trial
(ADR-0010, Plan 0006). It takes approved plans off a committed queue and runs each to a merged local
`main` with no owner action in between. Per plan, it opens a git worktree lane, installs its
dependencies, merges `main` into the lane, and runs a read-only readiness check. The check is
skipped when `ready` or an earlier pass already cleared this plan's text against this `main`. Then
it starts one fresh headless `claude -p`
session per contiguous run of `dev` phases and checks each session's claim against `git`. After
merging `main` into the lane it runs its own gate, then starts a fresh `architect` session to review
the plan and a second one to close it on the branch. Last, it fast-forwards `main` and removes the
lane.

**It never pushes.** Everything stays on this machine until you read what happened and push.

**Anything it cannot decide parks the plan**, and the lane moves on. That covers a `human` phase, a
plan's own stop condition, a gate still red after its one repair session, a review still failing after
two fix rounds, a spend cap, a usage limit too far off to wait for, or a claim `git` does not bear out.

Everything project-specific lives in `project.mjs`: the owner vocabulary, the plan header and log-row
shapes, the lane directory prefix, the lane install and the gate. The engine under `lib/` imports
nothing outside `tools/conductor/`. The fork is not reformatted (`.prettierignore`) or linted
(`eslint.config.js` ignores `tools/`), so it stays diffable against its source.

## Before the first run

1. **Write `tools/conductor/local.json`.** Copy `local.example.json` and put in your own figures.
   The file is gitignored, and the conductor refuses to start without it, because it carries no
   default spend. Each session gets its step's `budget_usd` figure as `--max-budget-usd`, and the
   CLI checks it between turns, so a step can overrun by one turn's cost. `run_budget_usd` caps one
   run: reaching it pauses the run. An optional `"model": { "implement": "opus", ... }` picks the model
   per step.
2. **Check the queue.** `queue.json` is committed and the architect owns its order: a plan list per
   lane, an optional `after` list of plans that must merge first, and optional `add_dirs` for a plan
   that reads outside the repository. A queued plan must read `Status: approved`. That approval is
   the "go": no session restates the plan or waits (ADR-0010).
3. **Before queuing a plan, run `node tools/conductor/conductor.mjs ready NNNN`** (ADR-0016). It runs
   the readiness check against `main` in a throwaway worktree. A park prints the gap while the
   planning session can still fix the plan. A pass is recorded against the plan's text, ignoring its
   `Status:` line. Any later edit to the plan above its `## Implementation log` needs `ready` again.
4. **Run the preflight:** `node tools/conductor/conductor.mjs check`. It refuses when `local.json` is
   missing, when the queue names a plan that is not approved or waits on one it cannot reach, when a
   queued plan that has not started has no `ready` record matching its text, or when
   `claude --version` is neither a verified version nor a patch above one. A patch above one passes
   with a warning. The readiness records are gitignored state, so on a fresh clone the error names
   every queued plan to `ready`.
5. **Leave the main checkout alone while a run is live.** The fast-forward refuses a dirty main
   checkout, so work in progress there parks every close.

## Commands

All of them run from the main checkout as `node tools/conductor/conductor.mjs <command>`.

| Command | What it does |
|---|---|
| `ready NNNN` | Runs the readiness check on plan NNNN as it stands on `main`, in a detached worktree removed afterwards. On a pass it records the plan's contract hash and `main`'s tip. On a park it prints the phase, the detail and the transcript, and exits 1. After either, it warns when the plan's working copy differs above its `## Implementation log` from the text on `main` it checked: commit it and run `ready` again, or `check` refuses. Refused while a run is live. |
| `run [--lane a\|b] [--once \| --until-idle]` | Runs the queue until `pause`, `abort` or Ctrl+C. `--until-idle` ends once no lane can move; `--once` stops a lane after one plan. A live run re-reads `queue.json`. A plan added there unstarted and with no matching `ready` record gets one line, `NNNN queued during a live run: its readiness runs when the lane picks it`, and the lane runs the readiness check when it picks it. |
| `status` | Per lane: the plan, the step, the time in it and the spend so far, then every parked plan with its reason, and any resume ask a live run has not taken yet. Regenerates the digest. |
| `digest [--history]` | Rewrites `digest.md`. `--history` writes the per-run account to `digest-history.md`. |
| `resume NNNN` | Queues a parked plan again. Refused while the park's reason still holds, such as a `human` phase whose log row does not read `done`. Against a live run it leaves an ask, which the run takes when the plan's lane next picks a plan. That is after the plan the lane is running, which the answer names. |
| `park NNNN` | Parks a plan that has not merged, with an inbox entry. |
| `finding NNNN [<ref> --done\|--wontfix\|--filed <reason>]` | Lists a merged plan's closing findings, or records your disposition of one. |
| `adopt-close NNNN` | Records a close a lane already carries when its session lost its outcome. Verifies it first. |
| `pause [--off]` | Lets the plans in flight finish and starts no other. The stop that loses nothing. |
| `abort` | Stops the conductor and every session under it. A step in flight re-runs from scratch next time. |
| `prune` | Drops merged plans from `queue.json`. Commit the result. |
| `check` | The preflight alone. |

`run` prints one line per milestone, `HH:MM NNNN <what>`, and the same lines go to `state/live.log`.
They show step starts and ends with spend and turns, each commit and phase as it lands, each
`pnpm test`, `pnpm typecheck`, `pnpm lint` or `node --test` call a session makes, usage-window
changes, denied commands, and the gate. They are a display read from the CLI's stream, so a missing
line is not evidence that something did not happen.

## What to read afterwards

- **`tools/conductor/digest.md`**, the current state. **Needs you** comes first: every standing park
  with the file to read and the command that clears it, every merge with open findings, and every
  unreviewed repair that reached `main`. **Now** says what each lane is doing.
- **Each merged plan's `## Close review`**, under `docs/plans/done/`. The close session commits the
  whole review there, so the review that let the plan merge is in the repository, not only in
  `state/`.
- **`state/inbox.md`**, one entry per park, and `state/transcripts/` for any session's full stream.

Then add the run's parks, hand interventions and defects to **`FOLLOWUPS.md`**, and check that the
last run's open items were acted on. Then push, or fix what you disagree with in a new commit first.

## Acting on a park

`human_phase` and `claude_dir` resume themselves inside a live run once the phase's log row reads
`done`. So does `usage_limit` once its reset passes, `main_dirty` once the main checkout is clean on
`main`, and `deps_install` an hour after it failed, three times at most. None of them resumes over a
dirty worktree. Every other reason is yours: `resume` once you have acted.

| Reason | What to do before `resume` |
|---|---|
| `human_phase` | Do the phase, mark its log row `done` in the lane (`../peb-plan-NNNN`) and commit it there. |
| `claude_dir` | The phase declares a file under `.claude/`, which the CLI will not let a headless session write. Nothing was run. Do the phase in the lane, mark its row `done`, commit. |
| `deps_install` | `pnpm install --frozen-lockfile` failed in the lane, so no gate step could run. Nothing was run. The detail carries the install's tail. Fix the cause (network, the native build of `better-sqlite3`) and resume, which installs again. |
| `stop_condition`, `plan_wrong`, `question` | Read the transcript the inbox names and settle it in a human-started `/architect` session. A readiness `plan_wrong` implemented nothing: edit the plan, or resume to overrule it. |
| `gate_red` | The gate was red, one repair session ran, and it is still red. Fix the defect in the lane. |
| `check_red` | A session (implement, fix, repair, merge or close) found its own run of the checks red and could not make it green within its scope. Fix it by hand in the lane (`../peb-plan-NNNN`) and commit there, often a test pinned to data the merge moved. Leave the worktree clean. |
| `review_failed` | Read the last review under `state/reviews/`. Resuming grants two fresh fix rounds. |
| `disagreement` | A session's claim and `git` differ. Read the detail and the transcript before trusting the lane. |
| `cli_contract` | The CLI ran a session without the project hooks or without loading the skill. Verify the CLI (below) before resuming. |
| `lost_background` | A session left a background command unfinished. Check what the lane holds, then resume. |
| `usage_limit` | The usage limit's reset was too far off to wait for. Commit or `git restore` the half-done work in the lane, then resume. |
| `budget`, `api`, `no_outcome`, `bad_outcome` | Raise the budget in `local.json`, or read the transcript. Resuming re-runs the step. |
| `merge_conflict` | Resolve the conflict in the lane and commit the merge. |
| `merge_failed`, `main_dirty` | Clean the main checkout, or clear what refused the fast-forward. |

## How it stays safe

- **Settings.** Every session runs with `--settings tools/conductor/settings.conductor.json` and
  `--permission-mode dontAsk`. The allowlist covers `pnpm`, `node`, a subset of `git`, and `mkdir`,
  `rm` and `ls` inside the lane. It denies push, `Monitor`, the web, `rm` outside the lane,
  `pnpm dev` and `pnpm start`. It restates the project's deny-read of `.env` files and `data/**`.
  `test/settings.test.mjs` checks the gate and every command the prompts name against it.
- **Prompts.** `prompts/<mode>.md` is appended to each session's system prompt with its
  `CONDUCTOR-*` values filled in. Each skill's `## Conductor mode` section only hands control to it.
  Every session ends on a `conductor-outcome` block, and the conductor checks the block against
  `git` before it moves on.
- **Hooks.** The project's own hooks run in every session. `.claude/hooks/conductor-no-background.cjs`
  denies a backgrounded command when `CONDUCTOR_SESSION=1`, and appends a line per shell call to
  the step's `CONDUCTOR_HOOK_LOG`. A session that made a shell call and left no line parks
  `cli_contract`.
- **Fresh sessions.** The review and the close are separate processes, started with the plan path and
  the lane and nothing else.
- **Its own gate.** The conductor runs `project.mjs`'s gate itself at `pre-review`, after every fix
  round, on the close tip, and after a re-merge. It never takes a session's word that a check passed.
- **Merging `main`.** The lane merges `main` at `pre-readiness`, before the first implement session
  each time the plan is picked, so a plan amended on `main` reaches the lane with no hand
  fast-forward. It merges again at `pre-review`, and on the close's and the fast-forward's
  conflicts. A conflict at any of these points goes to one merge session. Each merge is recorded in
  the plan's `merges[]` with its point.
- **The close.** The close session runs the architect's close ceremony, bumps `package.json` and
  `CHANGELOG.md` when the plan warrants it, commits a `## Close review` section into the plan, and
  makes no tag. The conductor checks that the plan is under `docs/plans/done/` with `Status: done`
  and that section, that `package.json` on the tip carries any version the close claims, and that
  the tree is clean.

## The gate

`project.mjs`'s `gate`, in order, stopping at the first red: `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `node scripts/check-doc-links.mjs`, `node --test ".claude/hooks/*.test.mjs"`, and
`node --test "tools/conductor/test/*.test.mjs"`. Each `node --test` passes its quoted glob as one
argument, because Node 24 loads a directory argument as a module and runs no test. The whole Vitest
suite reruns at every gate. Each command's output is kept under `state/gates/`.

Every lane runs `pnpm install --frozen-lockfile` whenever its worktree has no `node_modules/`, because
no worktree is born with one. It reuses the pnpm store, and a failure parks `deps_install`.

## When the CLI updates

`VERIFIED_CLI` in `conductor.mjs` lists the `claude --version`s the headless contract was verified on
in Ritmolux before the fork. A higher patch of a listed version runs with a warning, which the digest
carries. Any other unlisted version is refused. The probe that verifies a new version lives in
Ritmolux (`tools/conductor/spike/` at the fork commit) and was not forked. Until a version is verified
here, the per-session checks are the evidence: the hook log must be non-empty after any shell call,
and the stream's `system/init` must list the skill the prompt invoked.

## Tests

```sh
node --test "tools/conductor/test/*.test.mjs"
```

No test spends money or needs a network. `test/fake-claude.mjs` stands in for the CLI, and
`test/lane-scenario.mjs` makes the commits a real session would, in throwaway repositories.
