import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveTypstRuntime, typstCandidates } from './typstRuntime.mjs';

test('Typst resolution prefers override, managed, packaged and then system', () => {
  const candidates = typstCandidates({ appRoot: 'C:/Scout/app', platform: 'win32', env: { SCOUT_TYPST_PATH: 'C:/custom/typst.exe' } });
  assert.deepEqual(candidates.map((entry) => entry.source), ['override', 'managed', 'packaged', 'system']);
  assert.equal(candidates[1].command, path.resolve('C:/Scout/app/.scout-runtime/typst.exe'));
});

test('Typst resolution reports the managed source and version', () => {
  const result = resolveTypstRuntime({
    appRoot: 'C:/Scout/app', platform: 'win32', env: {},
    exists: (file) => file.endsWith('.scout-runtime\\typst.exe') || file.endsWith('.scout-runtime/typst.exe'),
    spawn: (command, args, options) => {
      assert.deepEqual(args, ['--version']);
      assert.equal(options.timeout, 5_000);
      return { status: command.includes('.scout-runtime') ? 0 : 1, stdout: 'typst 0.14.2\n', stderr: '' };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.source, 'managed');
  assert.equal(result.version, 'typst 0.14.2');
});

test('Typst resolution gives an actionable repair diagnostic', () => {
  const result = resolveTypstRuntime({ appRoot: '/app', platform: 'linux', env: {}, exists: () => false, spawn: () => ({ status: null }) });
  assert.equal(result.available, false);
  assert.match(result.error, /repair or reinstall Scout/i);
});
