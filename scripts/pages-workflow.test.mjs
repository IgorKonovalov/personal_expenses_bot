// Checks for the Pages workflow. Run: `node --test "scripts/*.test.mjs"`
//
// Reads .github/workflows/pages.yml as text: every action is pinned to a commit, and the page is
// built before its directory is uploaded.

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

test('pins every uses: to a 40-character commit SHA', () => {
  const uses = lines.map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1]).filter(Boolean);
  assert.ok(uses.length > 0, 'the workflow names no action');
  for (const ref of uses) {
    assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${ref} is not pinned to a commit SHA`);
  }
});

test('runs pnpm build:webapp before uploading webapp/dist', () => {
  const build = lines.findIndex((line) => /^\s*-\s+run:\s*pnpm build:webapp\s*$/.test(line));
  const upload = lines.findIndex((line) => /uses:\s*actions\/upload-pages-artifact@/.test(line));
  assert.notEqual(build, -1, 'no `pnpm build:webapp` step');
  assert.notEqual(upload, -1, 'no upload-pages-artifact step');
  assert.ok(build < upload, 'the upload runs before the build');
  const uploadWith = lines.slice(upload + 1, upload + 4).join('\n');
  assert.match(uploadWith, /^\s*path:\s*webapp\/dist\s*$/m);
});
