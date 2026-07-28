import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexDeepLinkCapability, openCodexTask } from './codexDeepLink.mjs';

const checkedAt = '2026-07-28T12:00:00.000Z';

test('a registered local handler is supported and can target the exact task', () => {
  const capability = codexDeepLinkCapability({
    requestAccess: 'local',
    platform: 'darwin',
    handler: { registered: true },
    checkedAt,
  });
  assert.deepEqual(capability, {
    state: 'supported',
    canAttempt: true,
    reasonCode: null,
    checkedAt,
    platform: 'darwin',
  });
  assert.deepEqual(openCodexTask('019f1234-abcd-7890', capability), {
    state: 'attempting',
    canNavigate: true,
    href: 'codex://threads/019f1234-abcd-7890',
    taskId: '019f1234-abcd-7890',
    success: false,
    acknowledged: false,
    reasonCode: 'awaiting-device',
    resumeInstruction: 'If Codex does not open, copy this task ID and resume it in Codex on this device.',
  });
});

test('a missing handler is unavailable and retains an exact copyable fallback', () => {
  const capability = codexDeepLinkCapability({
    requestAccess: 'local',
    platform: 'win32',
    handler: { registered: false },
    checkedAt,
  });
  assert.equal(capability.state, 'unavailable');
  assert.equal(capability.canAttempt, false);
  const view = openCodexTask('task-exact-123', capability);
  assert.equal(view.canNavigate, false);
  assert.equal(view.taskId, 'task-exact-123');
  assert.match(view.resumeInstruction, /copy this task ID/i);
});

test('capability failures and unknown results are bounded without raw diagnostics', () => {
  const failed = codexDeepLinkCapability({
    requestAccess: 'local',
    platform: 'darwin',
    handler: {
      failed: true,
      error: '/Users/private/person failed person@example.test',
      stdout: 'token=secret',
    },
    checkedAt,
  });
  const unknown = codexDeepLinkCapability({
    requestAccess: 'local',
    platform: 'win32',
    handler: null,
    checkedAt,
  });
  assert.equal(failed.state, 'failed');
  assert.equal(unknown.state, 'unknown');
  assert.doesNotMatch(JSON.stringify({ failed, unknown }), /Users|person@|token|stdout|error/);
});

test('a remote browser never inherits the server host handler', () => {
  const capability = codexDeepLinkCapability({
    requestAccess: 'remote-owner',
    platform: 'darwin',
    handler: { registered: true },
    checkedAt,
  });
  assert.deepEqual(capability, {
    state: 'remote',
    canAttempt: false,
    reasonCode: 'browser-device-required',
    checkedAt,
    platform: null,
  });
});

test('unsupported platforms are unavailable', () => {
  const capability = codexDeepLinkCapability({
    requestAccess: 'local',
    platform: 'linux',
    handler: { registered: true },
    checkedAt,
  });
  assert.equal(capability.state, 'unavailable');
  assert.equal(capability.reasonCode, 'platform-unsupported');
  assert.equal(capability.canAttempt, false);
});

test('a launch attempt without acknowledgement never reports success', () => {
  const view = openCodexTask('task-123', {
    state: 'supported', canAttempt: true, reasonCode: null, checkedAt, platform: 'darwin',
  });
  assert.equal(view.state, 'attempting');
  assert.equal(view.success, false);
  assert.equal(view.acknowledged, false);
});

test('a bounded launch failure produces the exact fallback', () => {
  const view = openCodexTask('task-123', {
    state: 'failed', canAttempt: false, reasonCode: 'launch-failed', checkedAt, platform: 'darwin',
  });
  assert.equal(view.state, 'fallback');
  assert.equal(view.canNavigate, false);
  assert.equal(view.taskId, 'task-123');
  assert.equal(view.reasonCode, 'launch-failed');
});

test('hostile task IDs stay copyable but are never navigable', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const view = openCodexTask(hostile, {
    state: 'supported', canAttempt: true, reasonCode: null, checkedAt, platform: 'darwin',
  });
  assert.equal(view.taskId, hostile);
  assert.equal(view.canNavigate, false);
  assert.equal(view.href, null);
  assert.equal(view.reasonCode, 'invalid-task-id');
});

test('empty and overlong task identities cannot launch', () => {
  for (const task of ['', 'x'.repeat(257)]) {
    const view = openCodexTask(task, {
      state: 'supported', canAttempt: true, reasonCode: null, checkedAt, platform: 'win32',
    });
    assert.equal(view.canNavigate, false);
    assert.equal(view.href, null);
  }
});
