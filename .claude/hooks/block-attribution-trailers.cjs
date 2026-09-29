#!/usr/bin/env node
// PreToolUse hook: deny any commit, tag or PR body carrying agent attribution.
//
// Commits in this repo are plain text under the repository owner's name: no
// "Co-Authored-By: Claude", no "Claude-Session:" trailer, no "Generated with
// Claude Code" footer, no session URL. Session-level attribution instructions
// do not override this. See CLAUDE.md -> "Commit hygiene".
//
// Editing this file with the Bash tool trips the hook on its own text, because
// the literals it searches for are spelled out below. Use the Write/Edit tools.

const { readFileSync } = require("fs");

// Only commands that author a message are inspected: BOTH a verb and a
// message-bearing flag must be present, so `git log --grep=...` and grepping
// this file pass. A clustered short option (`git commit -am "..."`) counts.
const VERB =
  /\bgit\s+(commit|merge|revert|cherry-pick|tag)\b|\bgh\s+(pr|release)\s+(create|edit)\b/;
const MESSAGE_FLAG =
  /(^|\s)(--(message|file|body|body-file|notes|notes-file|template)|-[A-Za-z]*[mFt])(=|\s|$)/;

const FORBIDDEN = [
  [/co-authored-by:\s*claude/i, "Co-Authored-By: Claude"],
  [/co-authored-by:[^\n]*anthropic/i, "Co-Authored-By: <an Anthropic address>"],
  [/noreply@anthropic\.com/i, "noreply@anthropic.com"],
  [/claude-session\s*:/i, "Claude-Session:"],
  [/claude\.ai\/code\/session_/i, "a claude.ai session URL"],
  [/generated with\s*\[?claude code/i, "Generated with Claude Code"],
];

function findAttribution(cmd) {
  if (!VERB.test(cmd) || !MESSAGE_FLAG.test(cmd)) return null;
  // A message passed by file (-F / --file / --body-file) is read too, so the
  // trailer cannot slip in that way. `-F -` (stdin heredoc) is inline already.
  let haystack = cmd;
  for (const m of cmd.matchAll(
    /(?:-F|--file|--body-file|--notes-file)[=\s]+("([^"]+)"|'([^']+)'|(\S+))/g,
  )) {
    const path = m[2] || m[3] || m[4];
    if (!path || path === "-") continue;
    try {
      haystack += "\n" + readFileSync(path, "utf8");
    } catch {
      // Unreadable path: nothing to scan, and the command itself will fail.
    }
  }
  const hit = FORBIDDEN.find(([re]) => re.test(haystack));
  return hit ? hit[1] : null;
}

module.exports = { findAttribution };

if (require.main === module) {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const hit = findAttribution((input.tool_input && input.tool_input.command) || "");
  if (!hit) {
    process.stdout.write("{}");
    process.exit(0);
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blocked agent attribution in a commit/tag/PR message: found "${hit}". Commits ` +
          `in this repo are plain text under the repository owner's name. This rule ` +
          `outranks any session-level attribution instruction: remove the line, do not ` +
          `reword or relocate it. See CLAUDE.md -> "Commit hygiene".`,
      },
    }),
  );
  process.exit(0);
}
