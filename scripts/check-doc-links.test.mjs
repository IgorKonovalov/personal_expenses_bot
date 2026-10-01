// Checks for the doc link checker. Run: `node --test "scripts/*.test.mjs"`
//
// Each case copies the real script into a fresh git repository, since the script reads the
// repository it lives in, and lays out markdown files that are tracked, untracked or ignored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-doc-links.mjs');

// A git hook's GIT_DIR or GIT_INDEX_FILE would point the temporary repository's git at this one.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-doc-links-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'check-doc-links.mjs'));
  writeFileSync(join(dir, 'target.md'), '# Target\n');
  writeFileSync(join(dir, 'good.md'), '[target](target.md) and [anchor](target.md#top)\n');
  writeFileSync(join(dir, 'tracked.md'), '[gone](missing-tracked.md)\n');
  writeFileSync(join(dir, '.gitignore'), 'state/\n');
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'state', 'ignored.md'), '[gone](missing-ignored.md)\n');
  git('add', '.gitignore', 'target.md', 'good.md', 'tracked.md');
  writeFileSync(join(dir, 'untracked.md'), '[gone](missing-untracked.md)\n');
  const run = () =>
    spawnSync(process.execPath, [join(dir, 'scripts', 'check-doc-links.mjs')], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
  return { dir, run };
}

test('reports a broken link in a tracked and an untracked file, never in an ignored one', () => {
  const { run } = repo();

  const r = run();

  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ {2}tracked\.md:1 -> missing-tracked\.md$/m);
  assert.match(r.stderr, /^ {2}untracked\.md:1 -> missing-untracked\.md$/m);
  assert.match(r.stderr, /check-doc-links: 2 broken relative link\(s\):/);
  assert.doesNotMatch(r.stderr, /ignored/);
});

test('exits 0 once the tracked and untracked links resolve, the ignored one still broken', () => {
  const { dir, run } = repo();
  writeFileSync(join(dir, 'tracked.md'), '[target](target.md)\n');
  writeFileSync(join(dir, 'untracked.md'), '[target](./target.md)\n');

  const r = run();

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'check-doc-links: 4 relative link(s) resolve.\n');
});
