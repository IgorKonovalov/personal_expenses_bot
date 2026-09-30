CONDUCTOR-MODE: merge
CONDUCTOR-PLAN: {{plan}}
CONDUCTOR-PLAN-FILE: {{plan_file}}
CONDUCTOR-WHERE: {{where}}
CONDUCTOR-MAIN: {{main_tip}}
CONDUCTOR-CONFLICTED: {{conflicted}}
CONDUCTOR-LANE: {{lane}} on branch {{branch}}

The conductor started this session (ADR-0010), not a person. No one reads this conversation or
answers a question. Your skill's `## Conductor mode` section hands control to this prompt. Where this
prompt and the rest of the skill disagree, this prompt wins.

The conductor merged main into this lane at the point named above, and the merge conflicted in the
paths listed above. It aborted that merge, so the tree is clean. Your whole task is the merge:

- Run `git merge --no-edit main` yourself, resolve every conflict, and commit the merge with
  `git commit --no-edit`. Keep both sides' intent: this plan's work and what reached main meanwhile.
  Where the two cannot both hold, keep main's behaviour and adapt this plan's side to it.
- Change nothing beyond what resolving the conflict needs. No refactor, no plan edit, no new
  feature. The conductor's gate runs next on the tree you leave, and a review reads it after.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` to be sure the resolution builds.
- **Never start a command in the background, and never arm a Monitor.** Nothing re-invokes this
  session, so a backgrounded command is killed with it.
- **Shell calls run one command per call**, because the allowlist reads each one on its own. No
  chaining, no pipe and no cd. Git never takes -C. Read text with the Read and Grep tools or
  `git grep <pattern>`.
- **Never attempt an Edit or a Write under `.claude/`.** The CLI refuses one to a headless session. A
  conflict there is the owner's: park `merge_conflict` naming the file.
- Park rather than guess when a conflict needs a decision only the owner can make, or when the two
  sides contradict each other's design. Run `git merge --abort` first so the tree is clean.

The conductor checks your claim against git: the commit must be a merge whose second parent is
main, the tree must be clean, and no path listed above may still carry a conflict marker.

The last thing you print is exactly one fenced block tagged `conductor-outcome` holding one JSON object:

```conductor-outcome
{"kind": "merged", "plan": "{{plan}}", "commit": "<sha of the merge commit>"}
```

or

```conductor-outcome
{"kind": "parked", "plan": "{{plan}}", "reason": "merge_conflict | plan_wrong | question | check_red", "detail": "<one line: what, and the file to read>"}
```
