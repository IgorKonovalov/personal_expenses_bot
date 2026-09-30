// Checks for the VPS deploy script. Run: `node --test "scripts/*.test.mjs"`
//
// Each case runs the real script under sh with stub `git` and `docker` first on PATH. The stubs
// append their argv to a log and exit with the code the case asks for, so the order of calls and
// the stop-on-failure behaviour are observed without touching git or Docker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'deploy-vps.sh');

const DEPLOY_CALLS = [
  'git pull --ff-only',
  'docker compose up -d --build --wait --wait-timeout 180',
  'docker image prune -f',
  'docker builder prune -f --filter until=168h',
];

// failOn: a call prefix whose stub exits 1, e.g. 'git' or 'docker compose up'.
function deploy({ failOn, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'deploy-vps-'));
  const checkout = join(home, 'bots', 'personal-expenses-bot');
  const bin = join(home, 'stub-bin');
  const log = join(home, 'calls.log');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(bin);
  for (const name of ['git', 'docker']) {
    const stub = join(bin, name);
    writeFileSync(
      stub,
      `#!/bin/sh
call="${name} $*"
echo "$call" >> "${log}"
case "$call" in "${failOn ?? '__never__'}"*) exit 1 ;; esac
`,
    );
    chmodSync(stub, 0o755);
  }
  const r = spawnSync('sh', [script], {
    cwd: home,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status: r.status, calls, checkout, home };
}

test('runs the four deploy calls in order and ignores the SSH-requested command', () => {
  const { status, calls, checkout, home } = deploy({
    env: { SSH_ORIGINAL_COMMAND: 'touch pwned' },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, DEPLOY_CALLS);
  assert.equal(existsSync(join(checkout, 'pwned')), false);
  assert.equal(existsSync(join(home, 'pwned')), false);
});

test('a failed git pull stops the deploy before any docker call', () => {
  const { status, calls } = deploy({ failOn: 'git' });
  assert.notEqual(status, 0);
  assert.deepEqual(calls, ['git pull --ff-only']);
});

test('a failed compose up stops the deploy before pruning', () => {
  const { status, calls } = deploy({ failOn: 'docker compose up' });
  assert.notEqual(status, 0);
  assert.deepEqual(calls, DEPLOY_CALLS.slice(0, 2));
});
