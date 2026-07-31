import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireProviderAuthMutation,
  readProviderAuthMutation,
  releaseProviderAuthMutation,
} from './providerAuthMutation.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const owner = { host: 'synthetic-host', pid: 42, processStart: 'synthetic-start' };

function contender(root, provider) {
  const moduleUrl = new URL('./providerAuthMutation.mjs', import.meta.url).href;
  const source = `
    import os from 'node:os';
    import { acquireProviderAuthMutation } from ${JSON.stringify(moduleUrl)};
    const mutation = acquireProviderAuthMutation(
      process.env.SCOUT_AUTH_ROOT,
      process.env.SCOUT_AUTH_PROVIDER,
      {
        owner: { host: os.hostname(), pid: process.pid, processStart: 'process-' + process.pid },
        durationMs: 30000,
      },
    );
    process.stdout.write(mutation ? 'acquired' : 'blocked');
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, SCOUT_AUTH_ROOT: root, SCOUT_AUTH_PROVIDER: provider },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => (
      status === 0 ? resolve(stdout) : reject(new Error(stderr || `contender exited ${status}`))
    ));
  });
}

test('authentication mutation authority blocks only the same provider', (t) => {
  const root = workspace(t);
  const codex = acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_000, durationMs: 5_000, mutationId: 'codex-mutation-0001',
  });
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_001, durationMs: 5_000, mutationId: 'codex-mutation-0002',
  }), null);
  const claude = acquireProviderAuthMutation(root, 'claude', {
    owner, now: 1_001, durationMs: 5_000, mutationId: 'claude-mutation-01',
  });
  assert.equal(claude.provider, 'claude');
  assert.equal(readProviderAuthMutation(root, 'codex', { now: 1_002 }).mutationId, codex.mutationId);
});

test('simultaneous processes admit one auth mutation per provider', async (t) => {
  const root = workspace(t);
  const codex = await Promise.all(Array.from({ length: 4 }, () => contender(root, 'codex')));
  assert.equal(codex.filter((status) => status === 'acquired').length, 1);
  assert.equal(codex.filter((status) => status === 'blocked').length, 3);
  assert.deepEqual(
    (await Promise.all([contender(root, 'claude'), contender(root, 'claude')])).sort(),
    ['acquired', 'blocked'],
  );
});

test('expired authentication authority is recovered with a new capability', (t) => {
  const root = workspace(t);
  const expired = acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_000, durationMs: 10, mutationId: 'expired-mutation-01',
  });
  assert.equal(readProviderAuthMutation(root, 'codex', { now: 1_011 }), null);
  const recovered = acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_011, durationMs: 10, mutationId: 'recovered-mutation1',
  });
  assert.notEqual(recovered.mutationId, expired.mutationId);
  assert.throws(
    () => releaseProviderAuthMutation(root, expired, { now: 1_012 }),
    /capability was lost/,
  );
  assert.equal(releaseProviderAuthMutation(root, recovered, { now: 1_012 }), true);
  assert.equal(readProviderAuthMutation(root, 'codex', { now: 1_012 }), null);
});
