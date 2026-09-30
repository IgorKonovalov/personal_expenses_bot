// Bite checks for the PreToolUse deny-hooks. Run: `node --test ".claude/hooks/*.test.mjs"`
//
// Each case pipes a real hook payload through the hook as a child process, the
// same way Claude Code invokes it, so a broken require/JSON path fails here too.
// Edit with the Write/Edit tools: the attribution literals below would trip the
// attribution hook if this file were written through the Bash tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function run(hook, command) {
  const r = spawnSync('node', [join(here, hook)], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  return out.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
}

const cases = {
  'block-broad-git-add.cjs': {
    deny: [
      'git add -A',
      'git add .',
      'git add --all',
      'git add :/',
      'pnpm test && git add . && git commit -m x',
    ],
    allow: ['git add src/domain/money.ts', 'git add ./src/a.ts docs/plans/0001-x.md', 'git status'],
  },
  'block-attribution-trailers.cjs': {
    deny: [
      'git commit -m "feat: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
      "git commit -F - <<'EOF'\nfeat: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\nEOF",
      'gh pr create --title x --body "Generated with [Claude Code](https://claude.com/claude-code)"',
      'git tag -a v1.0.0 -m "Claude-Session: abc"',
    ],
    allow: [
      'git commit -m "feat(domain): add money parser"',
      'git log --grep=Co-Authored-By',
      'grep -n co-authored-by .claude/hooks/block-attribution-trailers.cjs',
    ],
  },
  'block-push-and-history-rewrite.cjs': {
    deny: [
      'git push',
      'git push origin main',
      'git commit --amend --no-edit',
      'git reset --hard HEAD~1',
      'git rebase main',
      'pnpm test && git push',
      'bash -c "git push"',
      'git -C ../other push',
    ],
    allow: [
      'git commit -m "docs: explain why we never git push from a session"',
      'git stash push -m wip',
      'git log origin/main',
      'git reset HEAD src/a.ts',
      "git commit -F - <<'EOF'\nchore: x\n\ngit push is the owner's\nEOF",
    ],
  },
};

for (const [hook, { deny, allow }] of Object.entries(cases)) {
  for (const cmd of deny) {
    test(`${hook} denies: ${cmd.split('\n')[0]}`, () => assert.equal(run(hook, cmd), 'deny'));
  }
  for (const cmd of allow) {
    test(`${hook} allows: ${cmd.split('\n')[0]}`, () => assert.equal(run(hook, cmd), 'allow'));
  }
}

// conductor-no-background.cjs decides on the tool input and the session's environment, so these
// pipe the whole payload and set the environment the conductor gives a session.
function runBackground(env) {
  const r = spawnSync('node', [join(here, 'conductor-no-background.cjs')], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test', run_in_background: true },
    }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'allow';
}

test('conductor-no-background.cjs denies run_in_background in a conductor-started session', () => {
  assert.equal(runBackground({ CONDUCTOR_SESSION: '1' }), 'deny');
});

test('conductor-no-background.cjs lets the same call through in an interactive session', () => {
  assert.equal(runBackground({}), 'allow');
});

test('conductor-no-background.cjs logs every call of a conductor session to CONDUCTOR_HOOK_LOG', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'peb-hook-log-')), 'hooks.log');
  assert.equal(runBackground({ CONDUCTOR_SESSION: '1', CONDUCTOR_HOOK_LOG: log }), 'deny');
  const lines = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.hook, l.tool, l.decision]),
    [['conductor-no-background', 'Bash', 'deny']],
  );
});
