# Conductor followups

Each conductor run's parks, hand interventions and defects, as followups for the next run. The
owner's condition for the conductor is that every run shrinks the hand work of the last. So before
a run, check that the previous run's open items were acted on. Newest run first. Figures come from
`conductor.mjs digest --history`. The trial's list (Plans 0007 and 0003) is Plan 0006's `### Notes`.

Status: `open`, `done (<commit>)` or `dropped (<why>)`.

## 2026-10-01 morning: Plans 0009, 0011 and 0014

Queue `a: 0009, 0011, 0014`, chained with `after`. Three merged: 0009 as v0.7.0, 0011 as
v0.8.0, 0014 as v0.9.0, each passing review in round 1. Two `run --until-idle` invocations:
09:21 to 09:33 local (0009 parked, the run idled) and 09:55 to 11:44 local. Spend was about
$46 in all ($4.86 + $41.13). Each plan's human live check merged as owed (`Blocks merge: no`).

### Hand interventions

| # | Plan | Park | What was done by hand |
|---|---|---|---|
| H1 | 0011, 0014 | `plan_wrong` at `ready` (queue time, before the run) | 0011 omitted the flow, menu and registration files for its new screen (`1b0d735`). 0014's dev-owned Phase 3 ran `docker`, which no session may; the check became a Dockerfile `RUN` step (`a38a34f`). Caught by F1's gate, so nothing ran. |
| H2 | 0009 | `question` before Phase 2 | Phase 2 had a non-allowlisted member edit in DM, which ADR-0014's allowlist drops. Owner chose to keep DM closed; plan and ADR-0014 amended in `de0bc1e`, then `resume` and a second `run`. |

### Followups

| # | Owner | Followup | Status |
|---|---|---|---|
| F14 | architect | **The Files touched gap recurs** for every new screen or flow (0004 H3, 0011 H1, 0009 Phase 4). `ready` now catches it, but each catch is a hand edit. Add a line to the plan template: a new screen, flow or menu entry also touches `flowSessions.ts`, `flows.ts`, `menu.ts` and `bot.ts`. | open |
| F15 | conductor (dev) | **`plan.mjs` silently ignores a `Blocks merge:` line with trailing text** (`no (reason)` matched nothing, so the phase would have parked). Report it as a plan error, as a malformed owner tag is. | open |
| F16 | architect | **Readiness passed 0009 twice and missed H2.** A done-when whose actor can't reach the handler (allowlist, owner-only, group vs DM) surfaced only mid-implementation. Add "can each done-when's actor reach this path?" to the readiness prompt's checks. | open |
| F17 | - | `prune` the merged 0009, 0011 and 0014 from `queue.json`. | done (this commit) |
| F18 | conductor (dev) | **`prune` drops a merged plan from its lane but leaves its `plans` entry** (`after` lists for 0011 and 0014 stayed). Cleared by hand in this commit. Drop the entry with the lane row. | open |

### Open product findings from the closes

Listed by `conductor.mjs finding NNNN`. The one worth a fix plan first: 0014 minor
`src/bot/receiptWorker.ts:62`, a throw after the fetcher answers refetches the receipt every tick
with no backoff, which hammers the tax authority's endpoint. 0014's `rsUrl.ts:15` (a link plus
words is refused) and 0009's `card.ts:47` (a group expense's "today" in the viewer's timezone)
follow. `/help` is now owed findings from 0003 and 0004.

## 2026-09-30 evening: Plans 0008, 0005 and 0004

Queue `a: 0008, 0005, 0004`. Three merged: 0005 as v0.4.0, 0008 as v0.5.0, 0004 as v0.6.0.
Two `run --until-idle` invocations: 19:43 to 20:15 and 20:16 to 21:01 local. The first idled with
two plans parked. Spend was $28.36 in all ($12.74 + $15.62). Usage went from 0.08 to 0.41 of the
5h window and from 0.17 to 0.20 of the 7d window.

### Hand interventions

| # | Plan | Park | What was done by hand |
|---|---|---|---|
| H1 | 0008 | `check_red` at close | A `/changelog` test pinned the live announcement map to exactly 0.3.0, 0.2.0 and 0.1.0, so the close's 0.4.0 entry broke it. The test now derives its expectation from the live map (`7a242b7` in the lane). |
| H2 | 0008 | `check_red` at the re-merge | 0005 had merged as v0.4.0 with no `versionAnnouncements` entry, which 0008's own test requires. The conflicts in `bot.test.ts` and `messages.ts` were resolved and the 0.4.0 `/settings` copy was written by hand (`eaac1b4` in the lane). That copy is the architect's under ADR-0013 and still needs the owner's read. |
| H3 | 0004 | `plan_wrong` at readiness | Files touched omitted `flowSessions.ts` (`Screen` union, `Flow` kinds), `screens.ts`, `handlers/menu.ts` and `handlers/card.ts`. Amended in `1bfc20d`, and the lane was fast-forwarded to `main` by hand before `resume`. |
| H4 | - | - | The first run idled after parking 0004 while the 0008 resume was still pending, so `run` had to be started again. |

### Followups

| # | Owner | Followup | Status |
|---|---|---|---|
| F1 | architect | **Every plan run so far with a readiness park has had a Files touched or plan gap** (0007 and 0003 in the trial, 0004 here). The trial's followup to re-check queued plans after each close wasn't acted on. Make it mechanical: before queuing, grep each phase's done-when symbols (types, handlers, keyboards) against the tree and list every file that defines them. Or run the readiness check at queue time, not at run time. | done (`67021e2`): `ready NNNN` and the queue-time gate (ADR-0016) |
| F2 | conductor (dev) | **Merge `main` into the lane before readiness** (the trial's followup, not yet built: `lane.mjs` merges only at `pre-review` and `close`). H3 repeated the hand fast-forward. | done (`1c342f6`): the lane merges `main` at `pre-readiness` |
| F3 | architect | **An announcement is owed for every bump that reaches `main`.** Once ADR-0013's map exists, any plan merging after another plan's bump needs that version's entry. A lane can't write it (H2). Either the close that bumps writes its own entry (0005's close predates the map, so this happened once), or the conductor's merge prompt may draft it from `CHANGELOG.md` for the close review to check. | done: `prompts/close.md` writes the entry; the architect skill's close ceremony says so (Plan 0010 close) |
| F4 | dev practice | **Don't pin tests to live, growing data** (version maps, command lists). Derive the expectation from the source, or test the function against a fixture (H1). Add to the dev skill's testing notes. | done (`ba971c4`): a bullet in the dev skill's standards |
| F5 | conductor (dev) | **`resume` overpromises.** It prints "the live run takes the resume on its next look, within a minute", but asks are taken only when the lane picks its next plan. 0008's ask waited 18 min behind 0005. Fix the wording, or call `takeAsks` at step boundaries. | done (`0a34068`): `resume` names when the lane takes the ask; `status` lists pending asks |
| F6 | conductor (dev) | **`run --until-idle` ended with a resume ask pending** (H4). Idle should check `resume-asks.jsonl` before exiting. | done (`0a34068`): the cause was across lanes, so an idle lane waits while another lane still runs (Plan 0010 Notes) |
| F7 | conductor (docs) | README's "Acting on a park" table has no `check_red` row (the close's or merge's own gate is red, and it needs a dev fix in the lane). | done (`de6ba38`) |
| F8 | conductor (dev) | The settings denied a read-only `git grep -n "..."` whose pattern held backticks and Cyrillic (0004 implement, 20:39). The session worked around it. Check whether the allowlist should match `git grep` with any quoted pattern. | done (`de6ba38`): the allowlist permits it, the CLI's substitution guard denied it; the prompts send such patterns to the Grep tool |
| F9 | owner | `claude` 2.1.284 is still unverified (warning only). Verify the headless contract and add it to `VERIFIED_CLI`. | done: Ritmolux's probe verified it on this machine (Ritmolux `6738f781`), ported to `VERIFIED_CLI` |
| F10 | owner | Read the hand-written 0.4.0 announcement in `src/bot/messages.ts` (H2). | done: the owner approved the copy |
| F11 | - | `prune` the merged 0008, 0005 and 0004 from `queue.json`. | done (this commit) |
| F12 | conductor (dev) | **A plan queued while a resident run is live skips the readiness gate.** `refreshQueue` reloads the queue without `readinessErrors`, and `ready` is refused during a live run, so only the lane's own readiness check covers it (Plan 0010 Followups). | open |
| F13 | conductor (dev) | **`ready` reads `main`'s tip, `check` hashes the main checkout's working copy.** A `ready` before committing a plan edit passes the old text, then `check` refuses. Warn in `ready` when the two contracts differ (Plan 0010 Followups). | open |

### Open product findings from the closes

Listed by `conductor.mjs finding NNNN`. Record a disposition there once acted on.

- 0004 minor `src/bot/messages.ts:257`: `/help` mentions neither past-date entry nor [Изменить].
  Together with 0003's open minor (categories, `/cancel`), `/help` is due one pass.
- 0005 minor `src/bot/messages.ts:209`: expired `setTimezone` pointed to `/categories`. It looks
  resolved by 0004's `5dd1081` (`flowExpired` now reads `Время ответа истекло. Начните заново.`).
  Mark it `--done`.
- 0008's three nits (registration descriptions, an `adminNotifier` test, `compareVersions` in the
  order test): done in `ba971c4`, dispositions recorded with `finding 0008 <ref> --done`.
