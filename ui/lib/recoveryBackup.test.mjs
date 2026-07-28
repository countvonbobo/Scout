import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  initializeRecoveryBackup, loadRecoveryHeader, recoveryFileList, restoreRecoveryBackup,
  restoreRecoveryBackupWithKey, rotateRecoveryPassphrase, unlockRecoveryKey, writeRecoveryBackup,
} from './recoveryBackup.mjs';
import * as recoveryBackup from './recoveryBackup.mjs';
import crypto from 'node:crypto';

const EXAMPLE_ENV = ['SECRET', 'example'].join('=') + '\n';
const CHANGED_ENV = ['SECRET', 'dummy'].join('=') + '\n';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-recovery-'));
  fs.mkdirSync(path.join(root, 'applications', 'example'), { recursive: true });
  fs.mkdirSync(path.join(root, '.scout', 'backups'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), EXAMPLE_ENV);
  fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.pdf'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.typ'), 'public source');
  fs.writeFileSync(path.join(root, '.scout', 'backups', 'before.json'), '{}');
  fs.writeFileSync(path.join(root, 'data', 'chats', 'example.json'), JSON.stringify({
    engine: 'codex', cliSessionId: 'device-local-session-secret', messages: [{ role: 'user', text: 'keep this transcript' }], filesTouched: [], handoffs: [],
  }));
  return root;
}

test('recovery backup encrypts only resumable ignored state and restores with either secret', () => {
  const root = fixture();
  const passphrase = 'correct horse battery staple';
  const created = initializeRecoveryBackup(root, passphrase, { devicePreferences: { startWithWindows: true, remoteAccess: { enabled: true, ownerLogin: 'must-not-move@example.com' } } });
  const raw = fs.readFileSync(path.join(root, '.scout-backup', 'v1', 'header.json'), 'utf8');
  assert.doesNotMatch(raw, /synthetic|cv\.pdf|startWithWindows|device-local-session-secret|keep this transcript/);
  assert.deepEqual(recoveryFileList(root), ['.env', '.scout/backups/before.json', 'applications/example/cv.pdf', 'data/chats/example.json']);
  assert.deepEqual(unlockRecoveryKey(created.header, passphrase), created.dataKey);
  assert.deepEqual(unlockRecoveryKey(created.header, created.recoveryKey), created.dataKey);

  const preserved = writeRecoveryBackup(root, created.dataKey, created.header);
  assert.equal(preserved.changed, false);

  for (const secret of [passphrase, created.recoveryKey]) {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-restored-'));
    const restored = restoreRecoveryBackup(root, target, secret);
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), EXAMPLE_ENV);
    assert.deepEqual(fs.readFileSync(path.join(target, 'applications', 'example', 'cv.pdf')), Buffer.from([0, 1, 2, 3]));
    const chat = JSON.parse(fs.readFileSync(path.join(target, 'data', 'chats', 'example.json'), 'utf8'));
    assert.equal(chat.cliSessionId, null);
    assert.equal(chat.messages[0].text, 'keep this transcript');
    assert.equal(chat.messages.at(-1).recoveryNotice, true);
    assert.equal(chat.recovered.providerSessionReset, true);
    assert.equal(restored.devicePreferences.startWithWindows, true);
    assert.equal(restored.devicePreferences.remoteAccess, undefined);
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan-owned recovery restore yields to an independent heartbeat and fences component mutations', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.pdf'), Buffer.alloc(8 * 1024 * 1024, 0x62));
  const created = initializeRecoveryBackup(root, 'correct horse battery staple');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-async-restored-'));
  let heartbeatTicks = 0;
  let fenceChecks = 0;
  const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 1);
  try {
    assert.equal(
      typeof recoveryBackup.restoreRecoveryBackupWithKeyAsync,
      'function',
      'the scan-owned restore must expose an asynchronous implementation',
    );
    const restored = await recoveryBackup.restoreRecoveryBackupWithKeyAsync(
      root,
      target,
      created.dataKey,
      created.header,
      { assertFence() { fenceChecks += 1; } },
    );

    assert.equal(restored.files, 4);
    assert.equal(fs.statSync(path.join(target, 'applications', 'example', 'cv.pdf')).size, 8 * 1024 * 1024);
    assert.ok(heartbeatTicks > 0, 'large recovery restore must yield to the independent heartbeat');
    assert.ok(fenceChecks >= 8, 'restore component mutations must be fenced individually');
  } finally {
    clearInterval(heartbeat);
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged encrypted files retain their blob and changed files rotate only their blob', () => {
  const root = fixture();
  const created = initializeRecoveryBackup(root, 'a sufficiently long passphrase');
  const first = loadRecoveryHeader(root);
  const firstIndex = JSON.stringify(first.index);
  const blobsBefore = new Map(fs.readdirSync(path.join(root, '.scout-backup/v1/files')).map((name) => [name, fs.readFileSync(path.join(root, '.scout-backup/v1/files', name), 'utf8')]));
  fs.writeFileSync(path.join(root, '.env'), CHANGED_ENV);
  writeRecoveryBackup(root, created.dataKey, first);
  const blobsAfter = new Map(fs.readdirSync(path.join(root, '.scout-backup/v1/files')).map((name) => [name, fs.readFileSync(path.join(root, '.scout-backup/v1/files', name), 'utf8')]));
  assert.notEqual(JSON.stringify(loadRecoveryHeader(root).index), firstIndex);
  assert.equal([...blobsAfter].filter(([name, value]) => blobsBefore.get(name) === value).length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('recovery passphrase rotation preserves encrypted data and the emergency key', () => {
  const root = fixture();
  const oldPassphrase = 'old sufficiently long passphrase';
  const newPassphrase = 'new sufficiently long passphrase';
  const created = initializeRecoveryBackup(root, oldPassphrase);
  const blobsBefore = fs.readdirSync(path.join(root, '.scout-backup/v1/files')).map((name) => [
    name, fs.readFileSync(path.join(root, '.scout-backup/v1/files', name), 'utf8'),
  ]);
  rotateRecoveryPassphrase(root, created.dataKey, newPassphrase);
  assert.throws(() => restoreRecoveryBackup(root, fs.mkdtempSync(path.join(os.tmpdir(), 'scout-old-pass-')), oldPassphrase), /incorrect/);
  assert.deepEqual(unlockRecoveryKey(loadRecoveryHeader(root), newPassphrase), created.dataKey);
  assert.deepEqual(unlockRecoveryKey(loadRecoveryHeader(root), created.recoveryKey), created.dataKey);
  assert.deepEqual(fs.readdirSync(path.join(root, '.scout-backup/v1/files')).map((name) => [
    name, fs.readFileSync(path.join(root, '.scout-backup/v1/files', name), 'utf8'),
  ]), blobsBefore);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wrong secrets and modified ciphertext are rejected', () => {
  const root = fixture();
  initializeRecoveryBackup(root, 'another sufficiently long passphrase');
  assert.throws(() => restoreRecoveryBackup(root, fs.mkdtempSync(path.join(os.tmpdir(), 'scout-bad-')), 'wrong but long enough'), /incorrect/);
  const blob = path.join(root, '.scout-backup/v1/files', fs.readdirSync(path.join(root, '.scout-backup/v1/files'))[0]);
  const value = JSON.parse(fs.readFileSync(blob, 'utf8'));
  const ciphertext = Buffer.from(value.data, 'base64url');
  ciphertext[0] ^= 1;
  value.data = ciphertext.toString('base64url');
  fs.writeFileSync(blob, JSON.stringify(value));
  assert.throws(() => restoreRecoveryBackup(root, fs.mkdtempSync(path.join(os.tmpdir(), 'scout-bad-')), 'another sufficiently long passphrase'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('authenticated recovery indexes still reject path traversal', () => {
  const root = fixture();
  const created = initializeRecoveryBackup(root, 'yet another long passphrase');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', created.dataKey, iv);
  cipher.setAAD(Buffer.from('scout-recovery-index-v1'));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({
    files: [{ path: '../../outside.txt', id: 'invalid', sha256: 'invalid', size: 0 }],
  }))), cipher.final()]);
  const header = {
    ...created.header,
    index: {
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      data: data.toString('base64url'),
    },
  };
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-traversal-'));
  assert.throws(() => restoreRecoveryBackupWithKey(root, target, created.dataKey, header), /Invalid recovery path/);
  assert.equal(fs.existsSync(path.resolve(target, '..', '..', 'outside.txt')), false);
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
