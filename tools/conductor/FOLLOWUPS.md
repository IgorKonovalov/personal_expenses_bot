# Conductor followups

Each conductor run's parks, hand interventions and defects, as followups for the next run. The
owner's condition for the conductor is that every run shrinks the hand work of the last. So before
a run, check that the previous run's open items were acted on. Newest run first. Figures come from
`conductor.mjs digest --history`. The trial's list (Plans 0007 and 0003) is Plan 0006's `### Notes`.

Status: `open`, `done (<commit>)` or `dropped (<why>)`.

## 2026-10-06 20:39 to 2026-10-07 07:43: Plans 0035, 0026, 0036 and 0032

Queue `a`: 0026, 0035, 0036, 0032, with 0030 queued after 0032 merged. Merged 0035 (v0.23.0),
0026 (v0.24.0), 0036 (v0.26.0) and 0032 (v0.25.0), all with 0 fix rounds. 2 parks, 11 h 5 min wall
including a 25 min usage-limit wait and an 8 h machine suspend, $50.06. A second run took 0030.

### Hand interventions

| # | Plan | Park | What was done by hand |
|---|---|---|---|
| H6 | 0032 | `plan_wrong` at `ready` (before the run) | F24 recurred: `WEBAPP_URL` reaches `createBot` only via `src/index.ts`, and vitest included only `src/`. Files touched amended (`7b0468a`). |
| H7 | 0026 | `plan_wrong` at the lane's readiness | `ready` had passed 0026 against `777c23f`; the lane's check against `7b0468a` found `src/bot/bot.ts` missing from Files touched, a gap the plan had all along. Amended (`bcaca5b`), then `resume`. |
| H8 | 0036 | `api` at review | The machine suspended during the review; the session sat on a dead stream for 8 h. Killed by hand on wake, then `resume`. |
| H9 | 0030 | none | Added to `queue.json` mid-run after 0032 merged (`18697f1`); the run ended `until-idle` without picking it. Started by hand: `ready 0030`, a second `run`. |
| H10 | 0030 | `human_phase` at Phase 2 | A blocking mid-plan phase needed a deploy, which needs the merge (as H3). Phase 2 made `Blocks merge: no`, Phase 3's budget fixed at 2048 (`98ff5e7`); main merged into the lane and the row marked `owed` by hand (`80188b8`), then `resume`. |
| H11 | 0030 | `merge_failed` at the fast-forward | Another session's staged plan edits sat in the main checkout. Waited for it to commit (`9cdc923`), then `resume`. |

### Followups

| # | Owner | Followup | Status |
|---|---|---|---|
| F32 | conductor (dev) | **No step has an idle timeout** (H8). A session whose stream writes nothing for, say, 15 min (or a wall-clock jump after a suspend) should be killed and re-run once, as the `api` park's resume does. | open |
| F33 | conductor (dev) | **Readiness is not stable across `main` tips** (H7): the same plan text passed and then parked on a gap that predates both checks. Either a pass should hold unless the plan or its Files touched changed on `main`, or `ready` should be told to check Files touched against the registration sites explicitly. | open |
| F34 | conductor (dev) | **A plan added to `queue.json` mid-run was not picked by `--until-idle`** (H9), though the README says a live run re-reads the queue. Reproduce with the fake CLI. | open |
| F35 | conductor (dev) | **`git ls-tree` is denied** to review sessions (0036, twice). Allowlist read-only `git ls-tree`. | open |
| F36 | architect | **A plan that must pin GitHub Actions to SHAs needs the SHAs in the plan**, since a headless session has no network. 0032's were checked by hand against their tags and are real but older (`upload-pages-artifact` v3.0.1, `deploy-pages` v4.0.5). | open |
| F37 | architect | **A `human` phase that needs a deploy can't block the merge** (H3, H10). Readiness should park such a plan before it runs: a blocking human phase whose What says deploy, redeploy or publish. Until then, the architect marks it `Blocks merge: no` when writing the plan. | open |

## 2026-10-05 22:07 to 2026-10-06 15:16: Plans 0028, 0029, 0025, 0027, 0013 and 0012

Queue `a` from the last run, plus 0034 queued mid-run. Merged 0028 (v0.14.0), 0029 (v0.16.0),
0025 (v0.17.0), 0027 (v0.18.0), 0013 (v0.19.0) and 0012 (v0.20.0); 0024 merged by hand
(v0.15.0). 3 parks, 17 h wall including a machine sleep overnight and a usage-limit wait, $94.38.
Stopped by `pause` after 0012 so 0034 runs in a live session.

### Hand interventions

| # | Plan | Park | What was done by hand |
|---|---|---|---|
| H1 | 0025 | `plan_wrong` at `ready` (before the run) | Phase 6 copied a sealed template onto new expense ids, which ADR-0020's binding can't open. ADR-0035 and the Phase 6 amendment (`037352b`). |
| H2 | 0024 | `question` at the fast-forward | F26 came true: 0024 and 0031 both closed v0.13.0. Re-versioned to v0.15.0 in the lane, merged main twice, gated, and fast-forwarded main by hand (`a852c8e`, `ad8abe1`); its worktree and branch removed by hand. Its state record still reads `queued`. |
| H3 | 0029 | `human_phase` at Phase 6 | The blocking phase needed a deploy, which needs the merge. Split into a blocking prep Phase 6 and an owed Phase 7 (`cd72ab7`, `e747178`); PRIVACY.md contact and the VPS `.env` done, then `resume`. |
| H4 | 0029 | none (after the merge) | The bot crash-looped about 2 h after a push shipped 0029 while the VPS `.env` still held `ALLOWED_TELEGRAM_IDS`, kept on purpose for pre-0029 deploys. Removed it and recreated the container. |
| H5 | 0025, 0013 | `stop_condition` / `question` before the last phase | The $15 implement budget ran out a phase short; `resume` gave the last phase a fresh session. Implement budget raised to $50, run budget to $300. |

### Followups

| # | Owner | Followup | Status |
|---|---|---|---|
| F28 | conductor (dev) | **No command records a hand merge.** After H2 the plan's record stays `queued` forever; `pickNext` skips it only because its file is under `done/`. Add `adopt-merge NNNN`, or let `prune` mark such a plan merged. | open |
| F29 | architect | **An env rename in a blocking human phase strands the push after the merge** (H4). Either the code accepts the old key with a warning for one release, or the phase that removes it is the push itself. Prefer the former in future plans. | open |
| F30 | conductor (dev) | **A budget park a phase short is mechanical** (H5): the session committed cleanly and left resume notes. Let it resume itself once, as `deps_install` does. | open |
| F31 | - | **Plan 0034 is queued but runs in a live session.** `prune` it, or remove it from lane `a`, before the next `run`. | done (`777c23f`) |

## 2026-10-02 to 2026-10-03: Plans 0024 to 0030 in lane a

Queue `a: 0024, 0029, 0028, 0025, 0013, 0027, 0030, 0015, 0026` (0012 added after 0024).
Nothing merged: 4 parks, 33 h wall, $26.30. Lane a then stopped at the worktree cap with
0024, 0028 and 0029 holding the three worktrees.

### Hand interventions

| # | Plan | Park | What was done by hand |
|---|---|---|---|
| H1 | 0024 | `human_phase` at Phase 5 | A post-deploy live check that blocked the merge. `6eca81a` marked the queued plans' live checks `Blocks merge: no`, then `resume`. |
| H2 | 0024 | `main_dirty` at the fast-forward | The main checkout had uncommitted work. Clean now; the next live run resumes it. Its lane closed as v0.13.0, which Plan 0031 has since taken on main, so the fast-forward meets a version conflict. |
| H3 | 0028 | `plan_wrong` at Phase 2 (in-lane readiness) | Files touched omitted `src/index.ts`, `src/bot/bot.ts` and `src/bot/testHarness.ts`, the route from config to a handler and the harness option. Amended (this commit). |
| H4 | 0029 | `human_phase` at Phase 6 | Deploy and open, deliberately blocking. Owner's to do; holds a worktree meanwhile. |

### Followups

| # | Owner | Followup | Status |
|---|---|---|---|
| F24 | architect | **A new config key that reaches a handler also touches `src/index.ts`, `src/bot/bot.ts` (`BotOptions`) and `src/bot/testHarness.ts`.** Same gap class as F14/F19 (0028 H3). Add the line to the plan template's Files touched guidance. | open |
| F25 | architect | **A blocking `human` phase parks a lane slot for days** (0029 H4), and with 0028 parked the cap stopped lane a. Queue a plan with a blocking human phase last, or raise `max_open_worktrees`. | done (0030 queued last, `777c23f`) |
| F26 | architect | **Two lanes closed the same version** (0024 and 0031 both v0.13.0), because 0031 was closed by hand while 0024 sat parked. Before a hand close, check the parked lanes' claimed versions. | open |
| F27 | - | Edits after `ready` (`6eca81a`) cleared six plans' readiness records, so each needs `ready` again before `check` passes. | done (re-run 2026-10-05 before this run) |

## 2026-10-01: Plan 0017 (interactive, not a run)

Plan 0017 changed the conductor's own sources, so `/dev` built it by hand. It closes F12, F13,
F15, F16 and F18. Its close review left two items.

### Followups

| # | Owner | Followup | Status |
|---|---|---|---|
| F22 | conductor (dev) | **`prune` reports "nothing to prune" when the lanes are clean but the `plans` map names a merged plan**, and keeps the map. `cmdPrune` writes only when `dropped` is non-empty. Rewrite whenever the pruned queue differs from the one read. | open |
| F23 | conductor (dev) | nit: `ready`'s drift warning after a park has no test; `cli.test.mjs` covers the pass only. | open |

## 2026-10-01 afternoon: Plan 0018

Queue `a: 0018`. Merged as v0.9.2: review round 1, no findings, no parks, no hand interventions.
One `run --until-idle`, 12:32 to 12:46 local, about $3.50. This is the first run with zero
hand work.

## 2026-10-01 midday: Plan 0016

Queue `a: 0016`. Merged as v0.9.1, review round 1, three nits. Two `run --until-idle`
invocations, 11:53 to 12:03 and 12:04 to 12:19 local. Spend was about $11 in all.

### Hand interventions

| # | Plan | Park | What was done by hand |
|---|---|---|---|
| H1 | 0016 | `plan_wrong` in Phase 4 | Files touched omitted `src/bot/flows.ts`, where `answerFlow` renders a flow's confirmation (and Phase 5's `restoreScreen`). Amended in `d726f30`, then `resume` and a second `run`. Readiness had passed the plan twice. |

### Followups

| # | Owner | Followup | Status |
|---|---|---|---|
| F19 | architect | **F14's template line covers a new screen or flow, but not a change to what an existing flow answers.** H1 changed a flow's confirmation, which `flows.ts` renders. Widen the line: any change to a flow's answer or a screen's rendering also touches `src/bot/flows.ts`. | done (this commit) |
| F20 | - | `prune` 0016 from `queue.json`. | done (this commit) |
| F21 | dev | **`scripts/check-doc-links.mjs` walks the filesystem, so it checks gitignored files.** In the main checkout it fails on `tools/conductor/state/reviews/0016-round-1.md`, whose review prose reads as a link. CI and lanes have no `state/`, so only the architect's close step sees it. List files with `git ls-files '*.md'` instead. | done (4057d61, Plan 0018 Phase 3) |

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
| F14 | architect | **The Files touched gap recurs** for every new screen or flow (0004 H3, 0011 H1, 0009 Phase 4). `ready` now catches it, but each catch is a hand edit. Add a line to the plan template: a new screen, flow or menu entry also touches `flowSessions.ts`, `flows.ts`, `menu.ts` and `bot.ts`. | done (this commit): the plan template's Files touched line |
| F15 | conductor (dev) | **`plan.mjs` silently ignores a `Blocks merge:` line with trailing text** (`no (reason)` matched nothing, so the phase would have parked). Report it as a plan error, as a malformed owner tag is. | done (c90a362, Plan 0017 Phase 1) |
| F16 | architect | **Readiness passed 0009 twice and missed H2.** A done-when whose actor can't reach the handler (allowlist, owner-only, group vs DM) surfaced only mid-implementation. Add "can each done-when's actor reach this path?" to the readiness prompt's checks. | done (d400d57, Plan 0017 Phase 4) |
| F17 | - | `prune` the merged 0009, 0011 and 0014 from `queue.json`. | done (this commit) |
| F18 | conductor (dev) | **`prune` drops a merged plan from its lane but leaves its `plans` entry** (`after` lists for 0011 and 0014 stayed). Cleared by hand in this commit. Drop the entry with the lane row. | done (a53f3cd, Plan 0017 Phase 2; see F22) |

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
| F12 | conductor (dev) | **A plan queued while a resident run is live skips the readiness gate.** `refreshQueue` reloads the queue without `readinessErrors`, and `ready` is refused during a live run, so only the lane's own readiness check covers it (Plan 0010 Followups). | done (7c34987, Plan 0017 Phase 3) |
| F13 | conductor (dev) | **`ready` reads `main`'s tip, `check` hashes the main checkout's working copy.** A `ready` before committing a plan edit passes the old text, then `check` refuses. Warn in `ready` when the two contracts differ (Plan 0010 Followups). | done (7c34987, Plan 0017 Phase 3) |

### Open product findings from the closes

Listed by `conductor.mjs finding NNNN`. Record a disposition there once acted on.

- 0004 minor `src/bot/messages.ts:257`: `/help` mentions neither past-date entry nor [Изменить].
  Together with 0003's open minor (categories, `/cancel`), `/help` is due one pass.
- 0005 minor `src/bot/messages.ts:209`: expired `setTimezone` pointed to `/categories`. It looks
  resolved by 0004's `5dd1081` (`flowExpired` now reads `Время ответа истекло. Начните заново.`).
  Mark it `--done`.
- 0008's three nits (registration descriptions, an `adminNotifier` test, `compareVersions` in the
  order test): done in `ba971c4`, dispositions recorded with `finding 0008 <ref> --done`.
