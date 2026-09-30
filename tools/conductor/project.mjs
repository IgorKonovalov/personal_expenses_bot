// Everything the conductor knows about this repository and nothing else knows (ADR-0010): the owner
// vocabulary, how a plan document spells its headings and log rows, where a lane lives, what a new
// lane installs, the gate, and how a test run's output reads. The engine under lib/ imports this
// module and nothing outside tools/conductor/.

export const project = {
  /** Every owner tag a phase may carry, and the ones a headless session implements. */
  owners: ["dev", "human"],
  implementers: ["dev"],

  /** `# 0007: Navigation shell` -> number, title. */
  planTitle: /^# (\d{4}): (.+)$/m,
  /** `### Phase 2: The harness speaks ...` -> id, title. */
  phaseHeading: /^### Phase (\d+[a-z]?): (.+)$/,
  /**
   * An `## Implementation log` row, `| 1: engine runs a fixture plan | dev | done | abc1234 |` ->
   * id, title, owner, state, commit. `logRowPrefix(id)` is the same row's head as a regex source,
   * which the owed marker rewrites in place.
   */
  logRow: /^\|\s*(\d+[a-z]?): ([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*$/,
  logRowPrefix: (id) => `\\|\\s*${id}: [^|]*`,

  /** A lane is `<repo's parent>/peb-plan-NNNN`, on branch `plan-NNNN-<slug>`. */
  lanePrefix: "peb-plan-",

  /**
   * Run in every lane before any session: no worktree is born with `node_modules/`, and every gate
   * step needs it. A failure parks `deps_install`.
   */
  laneInstall: ["pnpm", "install", "--frozen-lockfile"],

  /**
   * The conductor's gate, in order, stopping at the first red. `announce` gives a step its own
   * running/ended lines in the run terminal; the rest print one aggregate line. `tests` marks the
   * step whose output `testCounts` reads.
   */
  gate: [
    { name: "typecheck", cmd: ["pnpm", "typecheck"] },
    { name: "lint", cmd: ["pnpm", "lint"] },
    { name: "test", cmd: ["pnpm", "test"], announce: true, tests: true },
    { name: "doc links", cmd: ["node", "scripts/check-doc-links.mjs"] },
    { name: "hooks", cmd: ["node", "--test", ".claude/hooks/*.test.mjs"] },
    { name: "conductor", cmd: ["node", "--test", "tools/conductor/test/*.test.mjs"], announce: true },
  ],

  /**
   * The test or check a session's shell command runs, for the run terminal: { kind: "tests"|"check",
   * what } or null for anything else.
   */
  shellCall(command) {
    if (typeof command !== "string") return null;
    for (const seg of command.split(/&&|\|\||;|\||\n/)) {
      const m = seg.match(/\bpnpm\s+(test|typecheck|lint|vitest)\b(.*)$/);
      if (m) return { kind: m[1] === "test" || m[1] === "vitest" ? "tests" : "check", what: `pnpm ${m[1]}${m[2]}`.trim().slice(0, 50) };
      const t = seg.match(/\bnode\s+--test\b(.*)$/);
      if (t) return { kind: "tests", what: `node --test${t[1]}`.trim().slice(0, 50) };
    }
    return null;
  },

  /**
   * Vitest's `Tests` summary line: { passed, failed, skipped, failing: [names], summary } or null when
   * the output carries none. A failing test is a ` FAIL  <file> > <suite> > <name>` line.
   */
  testCounts(output) {
    const text = stripAnsi(String(output ?? ""));
    const summary = [...text.matchAll(/^\s*Tests\s+(.+?)\s*$/gm)].at(-1);
    if (!summary) return null;
    const counts = { passed: 0, failed: 0, skipped: 0, failing: project.failingTests(text), summary: summary[1] };
    for (const m of summary[1].matchAll(/(\d+) (passed|failed|skipped|todo)/g)) {
      counts[m[2] === "todo" ? "skipped" : m[2]] += Number(m[1]);
    }
    return counts;
  },

  /** The failing test names in a Vitest run's output, deduplicated, in order. */
  failingTests(output) {
    const text = stripAnsi(String(output ?? ""));
    const names = new Set();
    for (const m of text.matchAll(/^\s*FAIL\s+(\S+\s+>\s+.+?)\s*$/gm)) names.add(m[1]);
    return [...names];
  },
};

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
