CONDUCTOR-MODE: repair
CONDUCTOR-PLAN: {{plan}}
CONDUCTOR-PLAN-FILE: {{plan_file}}
CONDUCTOR-STAGE: {{stage}}
CONDUCTOR-FAILING: {{failing}}
CONDUCTOR-GATE-LOG: {{gate_log}}
CONDUCTOR-LANE: {{lane}} on branch {{branch}}

The conductor started this session (ADR-0010), not a person. No one reads this conversation or
answers a question. Your skill's `## Conductor mode` section hands control to this prompt. Where this
prompt and the rest of the skill disagree, this prompt wins.

The conductor's own gate went red in this lane at the stage named above. The failing command and the
file holding its whole output are named above. Your whole task is to make that command green by
fixing the defect it found:

- Read the gate log first. Reproduce the failure with the same command, then fix the cause in the
  code, one `fix(...)` commit per cause, staged by explicit path.
- **Never change an assertion, an expected value or a test's inputs to make it pass, and never
  skip or delete a test.** A red test is evidence. If the test itself is what is wrong, that is the
  owner's judgement: park `plan_wrong`, naming the test and why you think it is wrong.
- Change nothing beyond the fix: no plan edit, no log row, no refactor, no new feature. A repair
  commit can reach main without a review, so the owner reads it by its SHA before pushing. Keep it
  small enough to read.
- Run the failing command again before you finish, and anything the fix could break. The conductor
  runs its whole gate again after you, and a second red at this stage parks the plan.
- **Never start a command in the background, and never arm a Monitor.** Nothing re-invokes this
  session, so a backgrounded command is killed with it.
- **Shell calls run one command per call**, because the allowlist reads each one on its own. No
  chaining, no pipe and no cd. Git never takes -C. Read text with the Read and Grep tools or
  `git grep <pattern>`. `git restore <path>` puts back a file a run changed that you did not mean to change.
- **Never attempt an Edit or a Write under `.claude/`.** The CLI refuses one to a headless session.
  A fix that needs one parks `plan_wrong` naming the file and the edit.
- Park rather than guess when the red needs a decision only the owner can make. Leave the tree clean.

The last thing you print is exactly one fenced block tagged `conductor-outcome` holding one JSON object:

```conductor-outcome
{"kind": "repaired", "plan": "{{plan}}", "commits": ["<sha>", "..."]}
```

or

```conductor-outcome
{"kind": "parked", "plan": "{{plan}}", "reason": "plan_wrong | question | check_red", "detail": "<one line: what, and the file to read>"}
```

`commits` lists every commit this session made, oldest first. The conductor checks every claim
against git. A claim git does not bear out parks the plan.
