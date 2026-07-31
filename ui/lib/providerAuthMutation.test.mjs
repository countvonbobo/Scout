import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireProviderAuthMutation,
  acquireProviderWork,
  readProviderAuthMutation,
  releaseProviderAuthMutation,
  releaseProviderWork,
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

function mixedContender(root, kind) {
  const moduleUrl = new URL('./providerAuthMutation.mjs', import.meta.url).href;
  const source = `
    import os from 'node:os';
    import { acquireProviderAuthMutation, acquireProviderWork } from ${JSON.stringify(moduleUrl)};
    const owner = { host: os.hostname(), pid: process.pid, processStart: 'process-' + process.pid };
    try {
      const capability = process.env.SCOUT_AUTH_KIND === 'auth'
        ? acquireProviderAuthMutation(process.env.SCOUT_AUTH_ROOT, 'codex', {
          owner, durationMs: 30000, mutationId: 'mixed-auth-operation-' + process.pid,
        })
        : acquireProviderWork(process.env.SCOUT_AUTH_ROOT, 'codex', {
          owner, durationMs: 30000, workId: 'mixed-work-operation-' + process.pid,
        });
      process.stdout.write(capability ? 'acquired' : 'blocked');
    } catch (error) {
      process.stdout.write(
        ['provider-auth-in-progress', 'provider-work-in-progress'].includes(error?.reasonCode)
          ? 'blocked' : 'error',
      );
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, SCOUT_AUTH_ROOT: root, SCOUT_AUTH_KIND: kind },
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
      status === 0 ? resolve(stdout) : reject(new Error(stderr || `mixed contender exited ${status}`))
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

test('provider work and authentication mutation are mutually exclusive under one guard', (t) => {
  const root = workspace(t);
  const work = acquireProviderWork(root, 'codex', {
    owner,
    now: 1_000,
    durationMs: 5_000,
    workId: 'provider-work-0001',
  });
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner,
    now: 1_001,
    durationMs: 5_000,
    mutationId: 'blocked-auth-0001',
  }), null);
  assert.equal(releaseProviderWork(root, work, { now: 1_002 }), true);

  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner,
    now: 1_003,
    durationMs: 5_000,
    mutationId: 'active-auth-000001',
  });
  assert.throws(() => acquireProviderWork(root, 'codex', {
    owner,
    now: 1_004,
    durationMs: 5_000,
    workId: 'blocked-work-0001',
  }), (error) => error.reasonCode === 'provider-auth-in-progress');
  releaseProviderAuthMutation(root, auth, { now: 1_005 });
});

test('simultaneous auth and provider-work processes admit exactly one class of operation', async (t) => {
  const root = workspace(t);
  const outcomes = await Promise.all([
    mixedContender(root, 'auth'),
    mixedContender(root, 'work'),
  ]);
  assert.deepEqual(outcomes.sort(), ['acquired', 'blocked']);
});
