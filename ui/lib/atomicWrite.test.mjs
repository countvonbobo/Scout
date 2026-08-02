import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from './atomicWrite.mjs';

test('atomic writes flush and replace a complete file without leaving temporary data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-atomic-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data', 'record.json');
  atomicWriteFile(file, '{"version":1}\n', { mode: 0o600 });
  atomicWriteFile(file, '{"version":2,"complete":true}\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, complete: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['record.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('writes, flushes, replaces, and then flushes the containing directory in order', () => {
  const calls = [];
  const fileSystem = {
    constants: fs.constants,
    existsSync: () => false,
    mkdirSync: (directory, options) => calls.push(['mkdir', directory, options]),
    openSync: (file, flags) => {
      calls.push(['open', path.basename(file), flags]);
      return file.endsWith('.tmp') ? 10 : 20;
    },
    writeSync: (descriptor, bytes, offset, length) => {
      calls.push(['write', descriptor, bytes.subarray(offset, offset + length).toString()]);
      return length;
    },
    fsyncSync: (descriptor) => calls.push(['fsync', descriptor]),
    closeSync: (descriptor) => calls.push(['close', descriptor]),
    renameSync: (source, destination) => calls.push(['rename', path.basename(source), path.basename(destination)]),
    rmSync: () => calls.push(['rm']),
  };

  atomicWriteFile('/workspace/runs/run-1/manifest.json', '{}\n', { fileSystem });

  assert.deepEqual(calls.map(([operation]) => operation), [
    'mkdir', 'open', 'write', 'fsync', 'close', 'rename', 'open', 'fsync', 'close',
  ]);
  assert.match(calls[1][1], /^\.manifest\.json\.\d+\.[0-9a-f-]+\.tmp$/i);
  assert.equal(calls[5][2], 'manifest.json');
  assert.deepEqual(calls.slice(6).map(([, descriptor]) => descriptor), ['run-1', 20, 20]);
});

test('critical workspace writers use the shared atomic replacement path', () => {
  const criticalModules = [
    'chatStore.mjs', 'companyStore.mjs', 'cvQuality.mjs', 'env.mjs',
    'onboardingProposal.mjs', 'recoveryBackup.mjs', 'scanPipeline.mjs',
    'trackerPersistence.mjs', 'workspace.mjs', 'workspaceSync.mjs',
  ];
  for (const module of criticalModules) {
    const source = fs.readFileSync(new URL(module, import.meta.url), 'utf8');
    assert.match(source, /atomicWriteFile/);
    assert.doesNotMatch(source, /writeFileSync\(/, `${module} bypasses atomic workspace persistence`);
  }
});
