// Checks for the Pages workflow. Run: `node --test "scripts/*.test.mjs"`
//
// Reads .github/workflows/pages.yml as text: every action is pinned to a commit, the Mini App and
// the docs site are built before the assembled directory is uploaded, and only a push to main
// deploys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'pages.yml'),
  'utf8',
);
const lines = workflow.split('\n');

const stepIndex = (run) =>
  lines.findIndex((line) => new RegExp(`^\\s*-\\s+run:\\s*${run}\\s*$`).test(line));

test('pins every uses: to a 40-character commit SHA', () => {
  const uses = lines.map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1]).filter(Boolean);
  assert.ok(uses.length > 0, 'the workflow names no action');
  for (const ref of uses) {
    assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${ref} is not pinned to a commit SHA`);
  }
});

test('builds the Mini App, the chats and the site before uploading .pages', () => {
  const upload = lines.findIndex((line) => /uses:\s*actions\/upload-pages-artifact@/.test(line));
  assert.notEqual(upload, -1, 'no upload-pages-artifact step');
  for (const run of ['pnpm build:webapp', 'pnpm docs:chats', 'pnpm --dir site build']) {
    const step = stepIndex(run);
    assert.notEqual(step, -1, `no \`${run}\` step`);
    assert.ok(step < upload, `the upload runs before \`${run}\``);
  }
  assert.ok(stepIndex('pnpm docs:chats') < stepIndex('pnpm --dir site build'));
  const uploadWith = lines.slice(upload + 1, upload + 4).join('\n');
  assert.match(uploadWith, /^\s*path:\s*\.pages\s*$/m);
});

test('builds every push and pull request, and deploys only a push to main', () => {
  assert.doesNotMatch(workflow, /^\s*paths:/m, 'a paths filter skips the docs build');
  assert.match(workflow, /^ {2}pull_request:/m);
  const deploy = lines.findIndex((line) => /^ {2}deploy:\s*$/.test(line));
  assert.notEqual(deploy, -1, 'no deploy job');
  const deployJob = lines.slice(deploy, deploy + 4).join('\n');
  assert.match(
    deployJob,
    /^\s*if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\s*$/m,
  );
});
