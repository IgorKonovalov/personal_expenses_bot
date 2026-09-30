# Conductor followups

Each conductor run's parks, hand interventions and defects, as followups for the next run. The
owner's condition for the conductor is that every run shrinks the hand work of the last. So before
a run, check that the previous run's open items were acted on. Newest run first. Figures come from
`conductor.mjs digest --history`. The trial's list (Plans 0007 and 0003) is Plan 0006's `### Notes`.

Status: `open`, `done (<commit>)` or `dropped (<why>)`.

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
| F1 | architect | **Every plan run so far with a readiness park has had a Files touched or plan gap** (0007 and 0003 in the trial, 0004 here). The trial's followup to re-check queued plans after each close wasn't acted on. Make it mechanical: before queuing, grep each phase's done-when symbols (types, handlers, keyboards) against the tree and list every file that defines them. Or run the readiness check at queue time, not at run time. | open |
| F2 | conductor (dev) | **Merge `main` into the lane before readiness** (the trial's followup, not yet built: `lane.mjs` merges only at `pre-review` and `close`). H3 repeated the hand fast-forward. | open |
| F3 | architect | **An announcement is owed for every bump that reaches `main`.** Once ADR-0013's map exists, any plan merging after another plan's bump needs that version's entry. A lane can't write it (H2). Either the close that bumps writes its own entry (0005's close predates the map, so this happened once), or the conductor's merge prompt may draft it from `CHANGELOG.md` for the close review to check. | open |
| F4 | dev practice | **Don't pin tests to live, growing data** (version maps, command lists). Derive the expectation from the source, or test the function against a fixture (H1). Add to the dev skill's testing notes. | open |
| F5 | conductor (dev) | **`resume` overpromises.** It prints "the live run takes the resume on its next look, within a minute", but asks are taken only when the lane picks its next plan. 0008's ask waited 18 min behind 0005. Fix the wording, or call `takeAsks` at step boundaries. | open |
| F6 | conductor (dev) | **`run --until-idle` ended with a resume ask pending** (H4). Idle should check `resume-asks.jsonl` before exiting. | open |
| F7 | conductor (docs) | README's "Acting on a park" table has no `check_red` row (the close's or merge's own gate is red, and it needs a dev fix in the lane). | open |
| F8 | conductor (dev) | The settings denied a read-only `git grep -n "..."` whose pattern held backticks and Cyrillic (0004 implement, 20:39). The session worked around it. Check whether the allowlist should match `git grep` with any quoted pattern. | open |
| F9 | owner | `claude` 2.1.284 is still unverified (warning only). Verify the headless contract and add it to `VERIFIED_CLI`. | open |
| F10 | owner | Read the hand-written 0.4.0 announcement in `src/bot/messages.ts` (H2). | open |
| F11 | - | `prune` the merged 0008, 0005 and 0004 from `queue.json`. | done (this commit) |

### Open product findings from the closes

Listed by `conductor.mjs finding NNNN`. Record a disposition there once acted on.

- 0004 minor `src/bot/messages.ts:257`: `/help` mentions neither past-date entry nor [Изменить].
  Together with 0003's open minor (categories, `/cancel`), `/help` is due one pass.
- 0005 minor `src/bot/messages.ts:209`: expired `setTimezone` pointed to `/categories`. It looks
  resolved by 0004's `5dd1081` (`flowExpired` now reads `Время ответа истекло. Начните заново.`).
  Mark it `--done`.
- 0008 nit `src/bot/bot.test.ts:328`: the registration test hardcodes the `/settings` and
  `/changelog` descriptions instead of reading `messages.commands[n]`.
- 0008 nit `src/bot/adminNotifier.ts:1`: no test drives `adminNotifier`/`sendHtml` (admin chat
  id, parse mode).
- 0008 nit `src/bot/bot.test.ts:359`: the H1 test sorts with `localeCompare` numeric instead of
  `compareVersions`, and no longer pins the literal order. Use `compareVersions`.
