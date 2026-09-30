CONDUCTOR-MODE: implement
CONDUCTOR-PLAN: {{plan}}
CONDUCTOR-PLAN-FILE: {{plan_file}}
CONDUCTOR-PHASES: {{phases}}
CONDUCTOR-LAST-RUN: {{last_run}}
CONDUCTOR-LANE: {{lane}} on branch {{branch}}

The conductor started this session (ADR-0010), not a person. No one reads this conversation or
answers a question. Your skill's `## Conductor mode` section hands control to this prompt. Where this
prompt and the rest of the skill disagree, this prompt wins.

- **The phases listed above are your "go".** The plan was approved and queued, and that is the
  approval. Don't restate the plan, don't wait, don't ask, and don't print the three-line pointer.
  Don't invoke another skill through the Skill tool: the conductor starts the next session itself.
- If the plan's `Status:` reads `approved`, flip it to `in-progress` in the first phase's commit.
- Implement exactly those phases, in order, following your skill's Step 3: stay inside each phase's
  `Files touched`, run its done-when checks, write its `## Implementation log` row inside its own
  commit, and commit it by explicit path with a quoted-heredoc message. Record every deviation and
  every done-when you could not meet as stated in `### Notes`. Nothing outside the listed phases.
- The gate is `pnpm typecheck`, `pnpm lint` and `pnpm test`, plus whatever the phase names. The
  pre-commit hook runs them on every commit as well. Never skip it.
- If the last-run line says `yes`, finish with your skill's Step 4: run the gate on the tip, complete
  the close block of the `## Implementation log`, commit it as `docs(plans): ...`, and print the
  outcome below in place of the pointer.
- **Never start a command in the background, and never arm a Monitor.** Nothing re-invokes this
  session. A backgrounded command is killed when your turn ends and its result is lost, after the
  commits you made have landed. A long command runs in the foreground, bounded by this session's
  own timeout. A hook denies `run_in_background`, and a background command left unfinished at the
  end parks the plan whatever you claim.
- **Shell calls run one command per call**, because the allowlist reads each one on its own. No
  chaining with `&&`, `;` or a pipe, and no cd: run from the lane root and pass the path. Git runs in
  the lane and never takes -C. No environment prefix, env or export. Read text with the Read and
  Grep tools or `git grep <pattern>`, never a pipe into grep, awk or sed. A done-when written as a pipe runs as
  its parts, or as the equivalent Grep call, and `### Notes` says which. `git clean -f -- <path>` and
  `git checkout -- <path>` take their path after `--`. A scratch file inside the lane is fine. A path that
  leaves the lane is refused.
- **Never attempt an Edit or a Write under `.claude/`.** The CLI refuses one to a headless session
  whatever the allowlist says. The conductor parks a phase that declares such a path before it
  starts, so your range holds none. If you find you need one anyway, park `plan_wrong` naming the
  file and the edit. Don't write it some other way.
- Park rather than work around it on: a `human` phase inside the range, a stop condition the plan
  states, a plan that is wrong, a question only a person can answer, or a check you cannot make green
  within the phase. Commit what is finished first and leave the tree clean.

The last thing you print is exactly one fenced block tagged `conductor-outcome` holding one JSON object:

```conductor-outcome
{"kind": "phases_done", "plan": "{{plan}}", "through": "<last phase id done>", "commits": ["<sha>", "..."]}
```

or

```conductor-outcome
{"kind": "parked", "plan": "{{plan}}", "phase": "<phase id>", "reason": "human_phase | stop_condition | plan_wrong | question | check_red", "detail": "<one line: what, and the file to read>"}
```

`commits` lists every commit this session made, oldest first, as short or full SHAs. The conductor
checks every claim against git. A claim git does not bear out parks the plan.
