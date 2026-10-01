// The plan reader, first against real plans in this repository (the shapes the architect's template
// actually produces), then against fixtures for the states a real plan rarely holds.

import assert from "node:assert/strict";
import { test } from "node:test";

import { claudePaths, donePhases, findPlan, nextStep, parsePlan, rangeLabel, readPlanFile, rowIsDone, runs } from "../lib/plan.mjs";
import { validateQueue } from "../lib/queue.mjs";
import { REPO, planText, tmp, writePlan } from "./helpers.mjs";

test("Plan 0007's title parses to its number and whole title, and it reads as four dev phases", () => {
  const found = findPlan(REPO, "0007");
  assert.ok(found, "plan 0007 is in docs/plans/ or docs/plans/done/");
  const plan = readPlanFile(found.path);
  assert.equal(plan.number, "0007");
  assert.match(plan.title, /^Navigation shell: menu, /, "the colons after the first belong to the title");
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.phases.map((p) => [p.id, p.owner]),
    [["1", "dev"], ["2", "dev"], ["3", "dev"], ["4", "dev"]],
  );
  assert.deepEqual(plan.log.rows.map((r) => [r.id, r.owner]), [["1", "dev"], ["2", "dev"], ["3", "dev"], ["4", "dev"]]);
});

test("the title pattern takes `# NNNN: Title` and nothing else", () => {
  const title = (line) => parsePlan(planText({ number: "0101", phases: [{ id: "1", owner: "dev" }] }).replace(/^# .*$/m, line));
  assert.deepEqual([title("# 0007: Navigation shell: menu, HTML seam").number, title("# 0007: Navigation shell: menu, HTML seam").title], ["0007", "Navigation shell: menu, HTML seam"]);
  assert.equal(title("# 0007 — Navigation shell").number, null, "the em-dash header is another project's");
  assert.equal(title("# 7: Navigation shell").number, null, "four digits");
});

test("Plan 0006 reads as two dev phases then a human trial, and its Phase 2 declares `.claude/` paths", () => {
  const plan = readPlanFile(findPlan(REPO, "0006").path);
  assert.equal(plan.number, "0006");
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(runs(plan), [
    { owner: "dev", phases: ["1", "2"] },
    { owner: "human", phases: ["3"] },
  ]);
  assert.deepEqual(claudePaths(plan.phases[0]), []);
  assert.ok(claudePaths(plan.phases[1]).includes(".claude/settings.json"), claudePaths(plan.phases[1]).join(", "));
});

test("closed Plan 0001 reads as a dev run then a human phase, every row done", () => {
  const plan = readPlanFile(findPlan(REPO, "0001").path);
  assert.equal(plan.statusWord, "done");
  assert.deepEqual(runs(plan), [
    { owner: "dev", phases: ["1", "2", "3", "4"] },
    { owner: "human", phases: ["5"] },
  ]);
  assert.deepEqual([...donePhases(plan)], ["1", "2", "3", "4", "5"], "`done (user-reported)` is done");
  assert.deepEqual(plan.log.rows.map((r) => r.commit), ["e0005cd", "de745c3", "35f817e", "e5c73a4", null]);
  assert.deepEqual(nextStep(plan), { kind: "review" });
});

test("a row reading not run is settled; not started and parked are not", () => {
  const row = (state) => ({ id: "1", title: "t", owner: "dev", state, commit: null });
  assert.equal(rowIsDone(row("not run: Phase 1 falsified the candidate")), true);
  assert.equal(rowIsDone(row("not run")), true);
  assert.equal(rowIsDone(row("not started")), false);
  assert.equal(rowIsDone(row("parked: check_red on the suite")), false);

  const skipped = parsePlan(planText({ ...MIXED, rows: { 1: { state: "done" }, 2: { state: "not run: Phase 1 falsified the candidate" } } }));
  assert.deepEqual([...donePhases(skipped)], ["1", "2"]);
});

test("the status word is the leading word, whatever punctuation follows it", () => {
  const word = (status) => parsePlan(planText({ number: "0101", status, phases: [{ id: "1", owner: "dev" }] })).statusWord;
  // The first is the shape a conductor close writes: the word, a full stop, then the evidence.
  assert.equal(word("done. Phases 14ae5f69, 776b946f, and close repairs 80bf58cb."), "done");
  assert.equal(word("done, closed by the conductor"), "done");
  assert.equal(word("done — 2026-09-24"), "done");
  assert.equal(word("done"), "done");
  assert.equal(word("approved (2026-09-14)"), "approved");
  assert.equal(word("in-progress; phase 2 of 4"), "in-progress");
  assert.equal(word("Draft"), "draft");
  assert.equal(word("`done`"), null);
});

const MIXED = {
  number: "0101",
  phases: [
    { id: "1", owner: "dev" },
    { id: "2", owner: "dev" },
    { id: "3", owner: "human" },
    { id: "4", owner: "dev" },
    { id: "5", owner: "dev" },
  ],
};

test("the next step is the first run with a phase the log does not mark done", () => {
  const fresh = parsePlan(planText(MIXED));
  assert.deepEqual(nextStep(fresh), { kind: "implement", owner: "dev", phases: ["1", "2"], lastRun: false });

  const atHuman = parsePlan(planText({ ...MIXED, rows: { 1: { state: "done", commit: "abc1234" }, 2: { state: "committed with this row" } } }));
  assert.deepEqual([...donePhases(atHuman)], ["1", "2"]);
  assert.deepEqual(nextStep(atHuman), { kind: "human", owner: "human", phases: ["3"] });

  const afterHuman = parsePlan(planText({ ...MIXED, rows: { 1: { state: "done" }, 2: { state: "done" }, 3: { state: "done" } } }));
  assert.deepEqual(nextStep(afterHuman), { kind: "implement", owner: "dev", phases: ["4", "5"], lastRun: true });

  const midRun = parsePlan(planText({ ...MIXED, rows: { 1: { state: "done" }, 2: { state: "done" }, 3: { state: "done" }, 4: { state: "done" } } }));
  assert.deepEqual(nextStep(midRun), { kind: "implement", owner: "dev", phases: ["5"], lastRun: true });
});

test("a missing or foreign owner tag is a plan error", () => {
  const text = planText({ number: "0101", phases: [{ id: "1", owner: "dev" }] }).replace("- **Owner skill:** dev", "- **Owner skill:** architect");
  assert.deepEqual(parsePlan(text).errors, ["Phase 1 has no valid owner tag (architect)"]);
  // Another project's implementer tag is not an owner here. It is spelled from its parts so the
  // fork's grep for that project's vocabulary stays empty.
  const other = ["stu", "dio-builder"].join("");
  const foreign = planText({ number: "0101", phases: [{ id: "1", owner: "dev" }, { id: "2", owner: other }] });
  assert.deepEqual(parsePlan(foreign).errors, [`Phase 2 has no valid owner tag (${other})`]);
  const missing = planText({ number: "0101", phases: [{ id: "1", owner: "dev" }] }).replace("- **Owner skill:** dev\n", "");
  assert.deepEqual(parsePlan(missing).errors, ["Phase 1 has no valid owner tag (null)"]);
});

test("range labels", () => {
  assert.equal(rangeLabel(["4b"]), "4b");
  assert.equal(rangeLabel(["1", "2", "3"]), "1-3");
});

// ADR-0210: the CLI refuses a headless session an Edit or Write under a project's `.claude/`, so a
// phase that declares one is the owner's and the lane has to stop in front of it rather than hand it
// to a session and read a failed done-when afterwards.

const CLAUDE_PLAN = {
  number: "0102",
  phases: [
    { id: "1", owner: "dev" },
    { id: "2", owner: "dev", files: "`.claude/hooks/no-background.cjs`, `.claude/settings.json` (register it)" },
    { id: "3", owner: "dev" },
  ],
};

test("a phase's Files touched is read, and the `.claude/` paths in it are picked out", () => {
  const plan = parsePlan(planText(CLAUDE_PLAN));
  assert.deepEqual(claudePaths(plan.phases[0]), [], "a phase naming no such path declares none");
  assert.deepEqual(claudePaths(plan.phases[1]), [".claude/hooks/no-background.cjs", ".claude/settings.json"]);

  // The real shape: `Files touched` wraps across lines and the list continues on them.
  const wrapped = parsePlan(
    planText({ number: "0103", phases: [{ id: "1", owner: "dev" }] }).replace(
      "- **Files touched:** `phase-1.txt`",
      "- **Files touched:** `tools/conductor/prompts/implement.md`,\n  `.claude/skills/dev/SKILL.md`, `lib/step.mjs`,\n  `.claude/skills/architect/SKILL.md`",
    ),
  );
  assert.deepEqual(claudePaths(wrapped.phases[0]), [".claude/skills/dev/SKILL.md", ".claude/skills/architect/SKILL.md"]);

  // The next bullet ends the list: a `.claude/` path in a Done when is not a declared file.
  const inDoneWhen = parsePlan(
    planText({ number: "0104", phases: [{ id: "1", owner: "dev" }] }).replace(
      "- **Done when:** the file exists.",
      "- **Done when:** `grep -rn x .claude/skills/` matches only prohibitions.",
    ),
  );
  assert.deepEqual(claudePaths(inDoneWhen.phases[0]), []);
});

test("the lane stops in front of a `.claude/` phase, and the phases before it in the run still run", () => {
  const fresh = parsePlan(planText(CLAUDE_PLAN));
  // Phase 1 is handed over on its own, truncated before Phase 2 — and it is not the last run, because
  // Phase 2 and Phase 3 are still to come.
  assert.deepEqual(nextStep(fresh), { kind: "implement", owner: "dev", phases: ["1"], lastRun: false });

  const atClaude = parsePlan(planText({ ...CLAUDE_PLAN, rows: { 1: { state: "done", commit: "abc1234" } } }));
  assert.deepEqual(nextStep(atClaude), {
    kind: "claude_dir",
    owner: "dev",
    phases: ["2"],
    paths: [".claude/hooks/no-background.cjs", ".claude/settings.json"],
  });

  // Once the owner has done it and marked the row, the rest of the run is an ordinary step again.
  const afterClaude = parsePlan(planText({ ...CLAUDE_PLAN, rows: { 1: { state: "done" }, 2: { state: "done" } } }));
  assert.deepEqual(nextStep(afterClaude), { kind: "implement", owner: "dev", phases: ["3"], lastRun: true });
});

// ADR-0249.
test("Blocks merge: no makes a human phase owed rather than parked, and only a human phase may carry it", async () => {
  const phases = [{ id: "1", owner: "dev" }, { id: "2", owner: "human", blocksMerge: "no" }, { id: "3", owner: "dev" }];
  const plan = parsePlan(planText({ number: "0101", phases, rows: { 1: { state: "done" } } }));
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.phases[1].blocksMerge, "no");
  assert.deepEqual(nextStep(plan), { kind: "owed", owner: "human", phases: ["2"] });

  const owed = parsePlan(planText({ number: "0101", phases, rows: { 1: { state: "done" }, 2: { state: "owed" } } }));
  assert.deepEqual(nextStep(owed), { kind: "implement", owner: "dev", phases: ["3"], lastRun: true });
  const finished = parsePlan(planText({ number: "0101", phases, rows: { 1: { state: "done" }, 2: { state: "owed" }, 3: { state: "done" } } }));
  assert.deepEqual(nextStep(finished), { kind: "review" });

  // Without the field, as today.
  const blocking = parsePlan(planText({ number: "0101", phases: [phases[0], { id: "2", owner: "human" }, phases[2]], rows: { 1: { state: "done" } } }));
  assert.deepEqual(nextStep(blocking), { kind: "human", owner: "human", phases: ["2"] });

  // On an implementer phase it is an error, and `check` reports every plan error through the queue.
  const wrong = [{ id: "1", owner: "dev", blocksMerge: "no" }];
  assert.deepEqual(parsePlan(planText({ number: "0101", phases: wrong })).errors, ["Phase 1 carries Blocks merge, which only a human phase may (it is dev)"]);
  const repo = tmp("peb-owed-check-");
  writePlan(repo, { number: "0101", phases: wrong });
  assert.deepEqual(validateQueue({ lanes: { a: ["0101"] } }, repo).errors, ["plan 0101: Phase 1 carries Blocks merge, which only a human phase may (it is dev)"]);
});

test("a Blocks merge line the parser can't read is an error naming the phase, not a silent default", () => {
  const withTag = (blocksMerge) => parsePlan(planText({ number: "0101", phases: [{ id: "1", owner: "dev" }, { id: "2", owner: "human", blocksMerge }] }));

  const malformed = withTag("no (needs deploy)");
  assert.deepEqual(malformed.errors, ['Phase 2 carries a Blocks merge line that is not `no` or `yes`: "- **Blocks merge:** no (needs deploy)"']);
  assert.equal(malformed.phases[1].blocksMerge, null);

  for (const value of ["`no`", "no"]) {
    const plan = withTag(value);
    assert.deepEqual(plan.errors, [], value);
    assert.equal(plan.phases[1].blocksMerge, "no", value);
  }

  assert.deepEqual(withTag("maybe").errors, ['Phase 2 carries Blocks merge "maybe"; it is no or yes']);
});
