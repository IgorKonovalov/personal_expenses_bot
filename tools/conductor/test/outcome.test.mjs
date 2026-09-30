// Where an outcome may carry `fixed_in`: on a closed verdict's minor or nit, as a SHA. And what a
// closed outcome's version and tag may be: a version with no tag, or a tag that names it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseOutcome } from "../lib/outcome.mjs";
import { outcomeBlock } from "./helpers.mjs";

const verdict = (findings) => ({
  round: 1,
  blockers: findings.filter((f) => f.severity === "blocker").length,
  majors: findings.filter((f) => f.severity === "major").length,
  minors: findings.filter((f) => f.severity === "minor").length,
  review_path: "state/reviews/0101-round-1.md",
  findings,
});
const closed = (findings) => ({ kind: "closed", plan: "0101", version: "0.1.1", tag: null, verdict: verdict(findings) });

test("a closed verdict's minor and nit may carry fixed_in as a SHA", () => {
  const r = parseOutcome(
    outcomeBlock(
      closed([
        { severity: "minor", file: "a.ts", line: 3, what: "stale comment", fixed_in: "a1b2c3d" },
        { severity: "nit", file: "b.md", line: null, what: "typo", fixed_in: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
        { severity: "minor", file: "c.ts", line: 9, what: "open" },
      ]),
    ),
  );
  assert.equal(r.ok, true, r.error);
});

test("fixed_in is refused on a verdict outcome, as a non-SHA, and on anything but a minor or nit", () => {
  const onVerdict = { kind: "verdict", plan: "0101", ...verdict([{ severity: "major", file: "a.ts", line: 1, what: "x" }, { severity: "minor", file: "a.ts", line: 2, what: "y", fixed_in: "a1b2c3d" }]) };
  assert.match(parseOutcome(outcomeBlock(onVerdict)).error, /fixed_in is only allowed on a closed verdict/);
  assert.match(parseOutcome(outcomeBlock(closed([{ severity: "minor", file: "a.ts", line: 1, what: "x", fixed_in: "HEAD" }]))).error, /fixed_in is not a SHA/);
  // A blocker or major cannot reach a closed outcome at all; the check still names a severity it will not take.
  const nitOk = parseOutcome(outcomeBlock(closed([{ severity: "nit", file: "a.ts", line: 1, what: "x", fixed_in: "a1b2c3d" }])));
  assert.equal(nitOk.ok, true);
});

test("a closed outcome carries a version with no tag, or a tag naming that version", () => {
  assert.equal(parseOutcome(outcomeBlock(closed([]))).ok, true, "a version, no tag");
  assert.equal(parseOutcome(outcomeBlock({ ...closed([]), tag: "v0.1.1" })).ok, true);
  assert.match(parseOutcome(outcomeBlock({ ...closed([]), tag: "v0.1.2" })).error, /closed\.tag does not name closed\.version/);
  assert.match(parseOutcome(outcomeBlock({ ...closed([]), tag: "release-1" })).error, /closed\.tag invalid/);
});

test("the block is read from a conductor-outcome fence, and a session that printed none has no outcome", () => {
  assert.equal(parseOutcome("```conductor-outcome\n" + JSON.stringify({ kind: "ready", plan: "0101" }) + "\n```\n").ok, true);
  assert.match(parseOutcome("Done, nothing to report.").error, /no conductor-outcome block/);
});
