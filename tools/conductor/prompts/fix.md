CONDUCTOR-MODE: fix
CONDUCTOR-PLAN: {{plan}}
CONDUCTOR-PLAN-FILE: {{plan_file}}
CONDUCTOR-ROUND: {{round}}
CONDUCTOR-REVIEW: {{review_path}}
CONDUCTOR-LANE: {{lane}} on branch {{branch}}

The conductor started this session (ADR-0010), not a person. No one reads this conversation or
answers a question. Your skill's `## Conductor mode` section hands control to this prompt. Where this
prompt and the rest of the skill disagree, this prompt wins.

A fresh architect review of this plan returned blockers or majors. The review is the file named
above. Its findings, numbered from 0 in the order the reviewer's verdict listed them:

{{findings}}

This is your skill's fix pass:

- Fix every `blocker` and `major`. A `minor` or `nit` is yours to leave.
- One `fix(...)` commit per finding or per tightly coupled group, staged by explicit path, with a
  quoted-heredoc message. Add one line per fix to the plan's `### Notes`, naming the finding and the
  commit. Touch nothing else in the plan.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test`, and any done-when the finding concerns.
- A finding you judge wrong is not yours to overrule and not yours to work around. Park
  `plan_wrong` naming it.
- **Never start a command in the background, and never arm a Monitor.** Nothing re-invokes this
  session, so a backgrounded command is killed with it.
- **Shell calls run one command per call**, because the allowlist reads each one on its own. No
  chaining, no pipe and no cd: run from the lane root and pass the path. Git runs in the lane and
  never takes -C. No environment prefix. Read text with the Read and Grep tools or `git grep <pattern>`.
  `git restore <path>` puts a file back.
- **Never attempt an Edit or a Write under `.claude/`.** The CLI refuses one to a headless session.
  A fix that needs one parks `plan_wrong` naming the file and the edit.

The last thing you print is exactly one fenced block tagged `conductor-outcome` holding one JSON object:

```conductor-outcome
{"kind": "fixed", "plan": "{{plan}}", "round": {{round}}, "commits": ["<sha>", "..."], "resolved": [{"finding": 0, "commit": "<sha>"}]}
```

or

```conductor-outcome
{"kind": "parked", "plan": "{{plan}}", "reason": "plan_wrong | question | check_red", "detail": "<one line>"}
```
