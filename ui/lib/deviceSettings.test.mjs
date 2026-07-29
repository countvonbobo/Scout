import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadDeviceSettings, pendingDeviceSections, saveDeviceSettings, setWindowsStartup,
  updateDownloadDirectory, windowsStartupStatus, windowsStartupTaskXml,
} from './deviceSettings.mjs';

test('device settings persist outside the app and retain defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-device-')); const file = path.join(root, 'state.json');
  const initial = loadDeviceSettings({ file }); assert.equal(initial.startWithWindows, false);
  assert.equal(initial.schemaVersion, 3); assert.equal(initial.remoteAccess.enabled, false);
  assert.equal(initial.updates.policy, 'notify');
  initial.startWithWindows = true; saveDeviceSettings(initial, { file });
  assert.equal(loadDeviceSettings({ file }).startWithWindows, true); fs.rmSync(root, { recursive: true, force: true });
});

test('verified update downloads stay in device-local state rather than the workspace', () => {
  const directory = updateDownloadDirectory({ LOCALAPPDATA: ['C:', 'Users', 'Owner', 'AppData', 'Local'].join('\\') }, 'win32');
  assert.match(directory, /AppData[\\/]Local[\\/]Scout[\\/]updates$/);
});

test('new Windows setup section prompts once and honours deferral', () => {
  const settings = loadDeviceSettings({ file: 'missing-device-settings-fixture' });
  assert.deepEqual(pendingDeviceSections(settings, { platform: 'win32', now: 1000 }).map((s) => s.id), ['windows-startup']);
  settings.deferredSections['windows-startup'] = new Date(2000).toISOString();
  assert.equal(pendingDeviceSections(settings, { platform: 'win32', now: 1000 }).length, 0);
  settings.completedSections['windows-startup'] = 1;
  assert.equal(pendingDeviceSections(settings, { platform: 'win32', now: 3000 }).length, 0);
});

test('Windows startup registration creates and verifies a supervised per-user task before removing the legacy Run entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-startup-')); const calls = [];
  const result = setWindowsStartup(true, 'C:\\Program Files\\Scout\\Scout.exe', {
    platform: 'win32', env: { USERDOMAIN: 'DESKTOP', USERNAME: 'Owner' }, tempDir: root, now: 0,
    spawn: (command, args) => { calls.push([command, args]); return { status: 0 }; },
  });
  assert.equal(result.ok, true); assert.deepEqual(calls[0][0], 'schtasks.exe'); assert.ok(calls[0][1].includes('/Create'));
  assert.ok(calls[1][1].includes('/Query')); assert.equal(calls[2][0], 'reg.exe');
  assert.equal(fs.readdirSync(root).length, 0); fs.rmSync(root, { recursive: true, force: true });
});

test('Windows startup task is delayed, least privilege, restartable and has no password', () => {
  const value = windowsStartupTaskXml('C:\\Program Files\\Scout\\Scout.exe', { env: { USERDOMAIN: 'DESKTOP', USERNAME: 'Owner' } });
  for (const marker of ['<Delay>PT15S</Delay>', '<LogonType>InteractiveToken</LogonType>', '<RunLevel>LeastPrivilege</RunLevel>', '<RestartOnFailure>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>']) assert.match(value, new RegExp(marker.replace(/[<>/]/g, '\\$&')));
  assert.doesNotMatch(value, /Password|HighestAvailable/);
});

test('failed Windows startup verification rolls back the new task and preserves legacy startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-startup-rollback-'));
  const calls = [];
  let index = 0;
  const results = [{ status: 0 }, { status: 1, stderr: 'verification failed' }, { status: 0 }];
  const result = setWindowsStartup(true, 'C:\\Scout\\Scout.exe', {
    platform: 'win32', env: { USERNAME: 'owner' }, tempDir: root, now: 0,
    spawn(command, args) { calls.push([command, args]); return results[index++]; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls.map(([command, args]) => `${command} ${args[0]}`), ['schtasks.exe /Create', 'schtasks.exe /Query', 'schtasks.exe /Delete']);
  assert.equal(calls.some(([command]) => command === 'reg.exe'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Windows startup status and disable tolerate absent tasks and remove the legacy entry', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (command === 'schtasks.exe') return { status: 1, stderr: 'ERROR: The system cannot find the file specified.' };
    return { status: 1, stderr: 'not found' };
  };
  assert.equal(windowsStartupStatus({ platform: 'win32', spawn }).enabled, false);
  const result = setWindowsStartup(false, 'C:\\Scout\\Scout.exe', { platform: 'win32', spawn, now: 0 });
  assert.equal(result.ok, true); assert.ok(calls.some(([command]) => command === 'reg.exe'));
});
