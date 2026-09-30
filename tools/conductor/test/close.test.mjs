// Reading a close off the branch, rather than out of a session's outcome (backlog 0229). These build
// the branch state by hand — the plan file, package.json, the tag, the tree — so each condition `closeOnBranch` and
// `adoptedClose` insist on has a case that isolates it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { adoptedClose, closeOnBranch, verifyClose } from "../lib/close.mjs";
import { findPlan } from "../lib/plan.mjs";
import { adoptClose } from "../lib/state.mjs";
import { planText, tmp, writePlan } from "./helpers.mjs";

function sh(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const SPEC = { number: "0101", phases: [{ id: "1", owner: "dev" }] };

function initRepo() {
  const repo = tmp("peb-close-repo-");
  sh(["init", "-q", "-b", "main"], repo);
  sh(["config", "user.email", "conductor-test@example.invalid"], repo);
  sh(["config", "user.name", "Conductor Test"], repo);
  sh(["config", "commit.gpgsign", "false"], repo);
  sh(["config", "tag.gpgSign", "false"], repo);
  sh(["config", "core.autocrlf", "false"], repo);
  return repo;
}

/** A package.json carrying `version`. */
const pkg = (version) => JSON.stringify({ name: "scratch", version, private: true }, null, 2) + "\n";

/**
 * A lane whose plan is as a finished close leaves it: under `done/`, `Status: done`, a
 * `## Close review`, `package.json` at 0.1.1 with no tag, clean. Each option undoes one of those;
 * `version: null` writes no package.json, and `tag` adds an annotated or a lightweight `v0.1.1`.
 */
function lane({ done = true, status = "done", closeReview = true, version = "0.1.1", tag = "none", dirty = false } = {}) {
  const repo = initRepo();
  writeFileSync(join(repo, "README.md"), "scratch\n");
  if (version !== null) writeFileSync(join(repo, "package.json"), pkg(version));
  writePlan(repo, { ...SPEC, status: `${status} - closed by the conductor`, closeReview: closeReview ? "Round 1: no blockers, no majors." : undefined });
  if (done) {
    mkdirSync(join(repo, "docs", "plans", "done"), { recursive: true });
    const from = findPlan(repo, "0101").path;
    renameSync(from, join(repo, "docs", "plans", "done", "0101-fixture.md"));
  }
  sh(["add", "README.md", "docs", ...(version !== null ? ["package.json"] : [])], repo);
  sh(["commit", "-q", "-m", "chore(release): 0.1.1"], repo);
  if (tag === "annotated") sh(["tag", "-a", "v0.1.1", "-m", "chore(release): 0.1.1"], repo);
  if (tag === "lightweight") sh(["tag", "v0.1.1"], repo);
  if (dirty) writeFileSync(join(repo, "suite-output.log"), "still compiling\n");
  return repo;
}

test("a finished close on the branch is found, and read back as the outcome it would have printed", () => {
  const repo = lane();
  const found = closeOnBranch(repo, "0101");
  assert.ok(found, "the close is on the branch");
  assert.match(readFileSync(found.path, "utf8"), /## Close review/);

  const o = adoptedClose({ cwd: repo, plan: "0101", round: 2 });
  assert.equal(o.kind, "closed");
  assert.equal(o.plan, "0101");
  assert.equal(o.version, "0.1.1", "read off the tip's package.json");
  assert.equal(o.tag, null, "a close here makes no tag");
  assert.equal(o.verdict.round, 2);
  // What is adopted is that a close happened, never a claim about what it found: the prose of the
  // `## Close review` is not machine-readable, so the verdict carries the path and no findings.
  assert.deepEqual(o.verdict.findings, []);
  assert.equal(o.verdict.review_path, found.path);
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: o }), []);
});

test("each thing a close must leave behind is separately required", () => {
  for (const [why, opts] of [
    ["the plan is still under docs/plans/", { done: false }],
    ["its Status is not done", { status: "in-progress" }],
    ["it has no ## Close review section", { closeReview: false }],
  ]) {
    const repo = lane(opts);
    assert.equal(closeOnBranch(repo, "0101"), null, why);
    assert.equal(adoptedClose({ cwd: repo, plan: "0101" }), null, why);
  }
  assert.equal(closeOnBranch(lane(), "0102"), null, "a plan that is not in the checkout at all");
});

test("a close whose tree is dirty is found but does not verify, so it is never adopted silently", () => {
  const repo = lane({ dirty: true });
  const o = adoptedClose({ cwd: repo, plan: "0101" });
  assert.ok(o, "the close is on the branch");
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: o }), ["the worktree is not clean"]);
});

test("an annotated tag on the tip is read as the close's tag, and names the version", () => {
  const repo = lane({ tag: "annotated" });
  const o = adoptedClose({ cwd: repo, plan: "0101" });
  assert.equal(o.tag, "v0.1.1");
  assert.equal(o.version, "0.1.1");
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: o }), []);
});

test("a claimed version the tip's package.json does not carry is a problem", () => {
  const repo = lane({ version: "0.1.0" });
  const o = { ...adoptedClose({ cwd: repo, plan: "0101" }), version: "0.1.1" };
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: o }), ["the close claims version 0.1.1, but package.json on the tip reads 0.1.0"]);
  const bare = lane({ version: null });
  assert.deepEqual(verifyClose({ cwd: bare, plan: "0101", outcome: o }), ["the close claims version 0.1.1, but package.json on the tip reads none"]);
});

test("a docs-only close carries no tag and no version, and still verifies", () => {
  const repo = lane({ version: null });
  const o = adoptedClose({ cwd: repo, plan: "0101" });
  assert.equal(o.tag, null);
  assert.equal(o.version, null);
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: o }), []);
});

test("a lightweight tag on the tip is not read as the close's tag", () => {
  // `verifyClose` rejects a lightweight tag, so adopting one would park the plan on a tag the close
  // never claimed.
  const repo = lane({ tag: "lightweight" });
  const o = adoptedClose({ cwd: repo, plan: "0101" });
  assert.equal(o.tag, null);
  assert.equal(o.version, "0.1.1");
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: o }), []);
});

test("a tag that is not on the tip is not read as the close's tag", () => {
  const repo = lane({ tag: "annotated" });
  writeFileSync(join(repo, "README.md"), "a commit after the tag\n");
  sh(["add", "README.md"], repo);
  sh(["commit", "-q", "-m", "docs: after the tag"], repo);
  assert.equal(adoptedClose({ cwd: repo, plan: "0101" }).tag, null);
});

const PLAN = "docs/plans/0101-fixture.md";
const DONE = "docs/plans/done/0101-fixture.md";
const GUIDE = Array.from({ length: 40 }, (_, i) => `guide line ${i}\n`).join("");

/**
 * A lane as a close that repaired a finding leaves it. Commit A (`repair`) edits the plan and
 * `docs/guide.md` at their pre-move paths; `main` then gains a commit (`mainCommit`: README only, or
 * the rename of the guide) and is merged in, as a close's `git merge main` does; commit B moves the
 * plan to `done/` with `Status: done` and a `## Close review` and bumps `package.json` to 0.1.1.
 * `longReview` makes the review longer than the whole plan was at A.
 */
function repairLane({ longReview = false, renameOnMain = false } = {}) {
  const repo = initRepo();
  writeFileSync(join(repo, "README.md"), "scratch\n");
  writeFileSync(join(repo, "package.json"), pkg("0.1.0"));
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "guide.md"), GUIDE);
  writePlan(repo, { ...SPEC, status: "in-progress" });
  sh(["add", "README.md", "package.json", "docs"], repo);
  sh(["commit", "-q", "-m", "docs: base"], repo);
  sh(["checkout", "-q", "-b", "plan-0101"], repo);

  writeFileSync(join(repo, PLAN), readFileSync(join(repo, PLAN), "utf8") + "\nA repaired nit.\n");
  writeFileSync(join(repo, "docs", "guide.md"), GUIDE.replace("guide line 3\n", "guide line 3, repaired\n"));
  sh(["add", "docs"], repo);
  sh(["commit", "-q", "-m", "docs(plans): repair a nit"], repo);
  const repair = sh(["rev-parse", "HEAD"], repo);

  sh(["checkout", "-q", "main"], repo);
  if (renameOnMain) sh(["mv", "docs/guide.md", "docs/guide-renamed.md"], repo);
  else {
    writeFileSync(join(repo, "README.md"), "main moved on\n");
    sh(["add", "README.md"], repo);
  }
  sh(["commit", "-q", "-m", "chore: main moves on"], repo);
  const mainCommit = sh(["rev-parse", "HEAD"], repo);
  sh(["checkout", "-q", "plan-0101"], repo);
  sh(["merge", "-q", "--no-ff", "--no-edit", "main"], repo);

  mkdirSync(join(repo, "docs", "plans", "done"), { recursive: true });
  sh(["mv", PLAN, DONE], repo);
  const review = longReview
    ? Array.from({ length: 200 }, (_, i) => `Round 1, observation ${i}: a paragraph the plan never held.`).join("\n")
    : "Round 1: no blockers, no majors. One nit, repaired.";
  writeFileSync(join(repo, DONE), planText({ ...SPEC, status: "done - closed by the conductor", closeReview: review }) + "\nA repaired nit.\n");
  writeFileSync(join(repo, "package.json"), pkg("0.1.1"));
  sh(["add", "docs", "package.json"], repo);
  sh(["commit", "-q", "-m", "chore(release): 0.1.1"], repo);
  return { repo, repair, mainCommit };
}

function repairedClose(file, fixedIn) {
  const finding = { severity: "nit", file, line: 3, summary: "a nit the close repaired", fixed_in: fixedIn };
  return { kind: "closed", plan: "0101", version: "0.1.1", tag: null, verdict: { round: 1, blockers: 0, majors: 0, minors: 0, review_path: DONE, findings: [finding] } };
}

function renameRows(repo, from) {
  return sh(["diff", "--name-status", "-M", from, "HEAD"], repo);
}

test("a repair of the plan file verifies under the path the close moved it to", () => {
  const { repo, repair } = repairLane();
  assert.match(renameRows(repo, repair), /^R\d+\tdocs\/plans\/0101-fixture\.md\tdocs\/plans\/done\/0101-fixture\.md$/m);
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: repairedClose(DONE, repair) }), []);
});

test("a repair of the plan file named by its pre-move path still verifies", () => {
  const { repo, repair } = repairLane();
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: repairedClose(PLAN, repair) }), []);
});

test("the plan's own move is followed even when the close grew it past git's rename similarity", () => {
  const { repo, repair } = repairLane({ longReview: true });
  const rows = renameRows(repo, repair);
  assert.doesNotMatch(rows, /^R\d+\t/m, "git pairs no rename, so only the plan's own pre-move path can match");
  assert.match(rows, /^D\tdocs\/plans\/0101-fixture\.md$/m);
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: repairedClose(DONE, repair) }), []);
});

test("a repair of a file that main renamed verifies under its new path", () => {
  const { repo, repair } = repairLane({ renameOnMain: true });
  assert.match(renameRows(repo, repair), /^R\d+\tdocs\/guide\.md\tdocs\/guide-renamed\.md$/m);
  assert.deepEqual(verifyClose({ cwd: repo, plan: "0101", outcome: repairedClose("docs/guide-renamed.md", repair) }), []);
});

test("a fixed_in commit that does not change the file, under any of its paths, is still a problem", () => {
  const { repo, mainCommit } = repairLane();
  const problems = verifyClose({ cwd: repo, plan: "0101", outcome: repairedClose(DONE, mainCommit) });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^finding 0 is fixed_in [0-9a-f]+, which does not change docs\/plans\/done\/0101-fixture\.md/);
  assert.match(problems[0], /docs\/plans\/0101-fixture\.md/, "the path the rename was followed to is named too");
});

// ADR-0248: the review records its verdict before the close runs, so an adopted close keeps it.
test("adopting a close keeps the clean verdict the review recorded, and records the adopted one only when there is none", () => {
  const adopted = adoptedClose({ cwd: lane(), plan: "0101", round: 2 });
  const clean = { round: 1, blockers: 0, majors: 0, minors: 1, review_path: "r1.md", findings: [{ severity: "minor", file: "a.md", line: 1, what: "left open" }], graded: "abc1234" };
  const rec = { verdicts: [clean], closed: null };
  adoptClose(rec, adopted, "f".repeat(40));
  assert.deepEqual(rec.verdicts, [clean], "the review's findings survive the adoption");
  assert.equal(rec.closed.adopted, true);
  assert.equal(rec.closed.version, "0.1.1");

  const bare = { verdicts: [{ round: 1, blockers: 0, majors: 1, minors: 0, review_path: "r1.md", findings: [] }], closed: null };
  adoptClose(bare, adopted, "f".repeat(40));
  assert.equal(bare.verdicts.length, 2, "a verdict with a major is not the closing one");
  assert.equal(bare.verdicts[1].review_path, adopted.verdict.review_path);
});
