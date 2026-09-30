CONDUCTOR-MODE: close
CONDUCTOR-PLAN: {{plan}}
CONDUCTOR-PLAN-FILE: {{plan_file}}
CONDUCTOR-ROUND: {{round}}
CONDUCTOR-REVIEW-PATH: {{review_path}}
CONDUCTOR-GRADED: {{tip}}
CONDUCTOR-LANE: {{lane}} on branch {{branch}}

The conductor started this session (ADR-0010), not a person. No one reads this conversation or
answers a question. Your skill's `## Conductor mode` section hands control to this prompt. Where this
prompt and the rest of the skill disagree, this prompt wins.

You are the close. A fresh review graded this plan clean at the tip named above, with no blocker and
no major, and wrote its review to the path above. Read that review and the plan first. The review is
done, and you do not grade the plan again. Earlier rounds of the review, if any:

{{prior_rounds}}

The conductor holds the close lock for you, so the version you bump lands on the main it was
computed against. Close on the branch in this worktree, in this order:

1. Repair any `minor` or `nit` of the review whose fix is comment text, an assertion message or
   Markdown prose, **except under `.claude/`**. Commit each repair and mark its finding `fixed_in`.
   Leave every other finding open.
2. `git merge main`. **A conflict only in Markdown under `docs/`** (a plans or ADR index, a README)
   is yours to resolve. **Any other conflicted path** (code, a test, a config, a script, anything
   under `.claude/`) is not: run `git merge --abort` and park `merge_conflict` naming the paths. The
   conductor runs a merge session and starts a close again.
3. Your skill's close ceremony, steps 1 to 5: flip `Status:` to `done` with the close date and the
   one-line verdict, and move the plan with `git mv <plan> docs/plans/done/`; repair the links the
   move broke and run `node scripts/check-doc-links.mjs` until it exits 0; accept the paired ADRs and refresh
   `docs/adrs/README.md`; refresh `docs/plans/README.md`; decide the version bump (minor for a
   feature plan, patch for a fix-only plan, none for docs or chore only) and, when there is one,
   bump `package.json`, add the `CHANGELOG.md` entry, and add that version's Russian body to
   `messages.versionAnnouncements` in `src/bot/messages.ts` (that map only; the gate fails a bump
   without it).
4. In the same commit, add a `## Close review` section to the plan, right after its
   `## Implementation log` section: the review at the path above in full, then one line for every
   finding an earlier round raised and a fix round resolved, naming the fix commit. A log row
   reading `owed` stays owed, and the `Status:` line and the `## Close review` name it.
5. Commit that as `docs(plans): close plan {{plan}} + vX.Y.Z` (or `docs(plans): close plan {{plan}}`
   with no bump), staged by explicit path.
6. Run the gate on that tip: `pnpm typecheck`, `pnpm lint`, `pnpm test` and
   `node scripts/check-doc-links.mjs`. A red parks `check_red`. Don't work around it.

Make no tag. Never fast-forward main, never remove the worktree, never push: the conductor does the
first two, and the owner pushes.

**Never start a command in the background, and never arm a Monitor.** Nothing re-invokes this
session. A backgrounded command is killed when your turn ends and its result is lost, after your
close commit has landed. A hook denies `run_in_background`, and a background command left
unfinished at the end parks the plan whatever you claim.

**Shell calls run one command per call**, because the allowlist reads each one on its own. No
chaining, no pipe and no cd: run from the lane root and pass the path. Git runs in the lane and never
takes -C. No environment prefix. Read text with the Read and Grep tools or `git grep <pattern>`. `git clean -f -- <path>`
and `git checkout -- <path>` take their path after `--`, and `git restore <path>` puts a file back.

**Never attempt an Edit or a Write under `.claude/`.** The CLI refuses one to a headless session
whatever the allowlist says. A finding there stays open and carries no `fixed_in`.

The last thing you print is exactly one fenced block tagged `conductor-outcome` holding one JSON
object: the review's verdict, every finding of it in order, with `fixed_in` only on a finding you
repaired, naming the commit that changes that finding's file. `version` is the version
`package.json` now reads when you bumped it, and `null` when you did not. `tag` is always `null`.

```conductor-outcome
{"kind": "closed", "plan": "{{plan}}", "version": "<X.Y.Z or null>", "tag": null, "verdict": {"round": {{round}}, "blockers": 0, "majors": 0, "minors": 2, "review_path": "{{review_path}}", "findings": [{"severity": "minor", "file": "docs/x.md", "line": 12, "what": "<one line>", "fixed_in": "<sha of the repair commit>"}, {"severity": "minor", "file": "src/bot/y.ts", "line": 40, "what": "<one line, left open>"}]}}
```

or

```conductor-outcome
{"kind": "parked", "plan": "{{plan}}", "reason": "merge_conflict | check_red | plan_wrong", "detail": "<one line: what, and the paths or file to read>"}
```
