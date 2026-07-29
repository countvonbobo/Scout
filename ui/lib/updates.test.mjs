import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkForUpdate, compareVersions, downloadVerifiedUpdate, packageName, parseChecksums,
  publicDownloadedUpdate,
} from './updates.mjs';

function streamedResponse(chunks, headers = {}) {
  return {
    ok: true,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(new Uint8Array(chunk)));
        controller.close();
      },
    }),
    arrayBuffer: async () => { throw new Error('package must not be buffered'); },
  };
}

test('beta versions compare numerically', () => {
  assert.equal(compareVersions('0.1.0-beta.10', '0.1.0-beta.9'), 1);
  assert.equal(compareVersions('v0.1.0-beta.7', '0.1.0-beta.7'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.0-beta.99'), 1);
});

test('download projection never exposes its device-local absolute path', () => {
  const projected = publicDownloadedUpdate({
    path: ['C:', 'Users', 'Owner', 'AppData', 'Local', 'Scout', 'updates', 'Scout.exe'].join('\\'),
    name: 'Scout.exe',
    sha256: 'a'.repeat(64),
    version: '0.1.0-beta.23',
    verifiedAt: '2026-07-29T10:00:00.000Z',
  });
  assert.deepEqual(projected, {
    name: 'Scout.exe',
    sha256: 'a'.repeat(64),
    version: '0.1.0-beta.23',
    verifiedAt: '2026-07-29T10:00:00.000Z',
  });
  assert.equal('path' in projected, false);
  assert.equal(publicDownloadedUpdate({
    path: '/private/update',
    name: '../private-update.exe',
    sha256: 'a'.repeat(64),
    version: '0.1.0',
    verifiedAt: '2026-07-29T10:00:00.000Z',
  }), null);
});

test('update check selects a newer verified Scout release and device package', async () => {
  const result = await checkForUpdate('0.1.0-beta.7', async () => ({ ok: true, json: async () => [
    { tag_name: 'v0.1.0-beta.8', draft: false, html_url: 'https://github.com/oliver-hitchings/Scout/releases/tag/v0.1.0-beta.8', body: 'Safer updates', published_at: '2026-07-18T10:00:00Z', assets: [
      { name: 'Scout-0.1.0-beta.8-windows-x64.exe', browser_download_url: 'https://github.com/oliver-hitchings/Scout/releases/download/v0.1.0-beta.8/Scout-0.1.0-beta.8-windows-x64.exe' },
      { name: 'checksums.txt', browser_download_url: 'https://github.com/oliver-hitchings/Scout/releases/download/v0.1.0-beta.8/checksums.txt' },
    ] },
  ] }), { platform: 'win32', arch: 'x64' });
  assert.equal(result.available, true); assert.equal(result.latestVersion, '0.1.0-beta.8');
  assert.equal(result.package.name, 'Scout-0.1.0-beta.8-windows-x64.exe');
  assert.equal(result.releaseNotes, 'Safer updates');
});

test('update check rejects a non-Scout release URL', async () => {
  const result = await checkForUpdate('0.1.0-beta.7', async () => ({ ok: true, json: async () => [
    { tag_name: 'v0.1.0-beta.8', draft: false, html_url: 'https://example.test/release' },
  ] }));
  assert.equal(result.available, false); assert.equal(result.url, null);
});

test('platform package names are explicit and unsupported devices do not guess', () => {
  assert.equal(packageName('1.2.3', 'win32', 'x64'), 'Scout-1.2.3-windows-x64.exe');
  assert.equal(packageName('1.2.3', 'darwin', 'arm64'), 'Scout-1.2.3-macos-arm64.dmg');
  assert.equal(packageName('1.2.3', 'linux', 'x64', { preferPortable: true }), 'Scout-1.2.3-linux-x64.tar.gz');
  assert.equal(packageName('1.2.3', 'linux', 'arm64'), null);
});

test('checksum parser rejects paths and verified download is written atomically', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('installer bytes');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(parseChecksums(`${digest}  ../bad.exe\n`).size, 0);
  const name = 'Scout-0.1.0-beta.12-windows-x64.exe';
  const base = 'https://github.com/oliver-hitchings/Scout/releases/download/v0.1.0-beta.12';
  const responses = new Map([
    [`${base}/checksums.txt`, { ok: true, text: async () => `${digest}  ${name}\n` }],
    [`${base}/${name}`, streamedResponse([bytes.subarray(0, 4), bytes.subarray(4)], { 'content-length': String(bytes.length) })],
  ]);
  const result = await downloadVerifiedUpdate({ available: true, currentVersion: '0.1.0-beta.11', latestVersion: '0.1.0-beta.12', package: { name, url: `${base}/${name}`, checksumsUrl: `${base}/checksums.txt` } }, directory, { fetchFn: async (url) => responses.get(url) });
  assert.equal(result.sha256, digest);
  assert.deepEqual(fs.readFileSync(result.path), bytes);
  assert.deepEqual(fs.readdirSync(directory), [name]);
});

test('verified download refuses a checksum mismatch', async () => {
  const name = 'Scout-0.1.0-beta.12-windows-x64.exe';
  const base = 'https://github.com/oliver-hitchings/Scout/releases/download/v0.1.0-beta.12';
  await assert.rejects(downloadVerifiedUpdate({ available: true, currentVersion: 'old', latestVersion: 'new', package: { name, url: `${base}/${name}`, checksumsUrl: `${base}/checksums.txt` } }, os.tmpdir(), { fetchFn: async (url) => url.endsWith('checksums.txt')
    ? { ok: true, text: async () => `${'0'.repeat(64)}  ${name}\n` }
    : streamedResponse([Buffer.from('b'), Buffer.from('ad')], { 'content-length': '3' }) }), /checksum verification failed/);
});

test('verified download enforces its byte limit while streaming and removes the partial file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-update-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const name = 'Scout-0.1.0-beta.12-windows-x64.exe';
  const base = 'https://github.com/oliver-hitchings/Scout/releases/download/v0.1.0-beta.12';
  const digest = crypto.createHash('sha256').update('abcdef').digest('hex');
  await assert.rejects(downloadVerifiedUpdate({
    available: true, currentVersion: 'old', latestVersion: 'new',
    package: { name, url: `${base}/${name}`, checksumsUrl: `${base}/checksums.txt` },
  }, directory, {
    maxPackageBytes: 5,
    fetchFn: async (url) => url.endsWith('checksums.txt')
      ? { ok: true, text: async () => `${digest}  ${name}\n` }
      : streamedResponse([Buffer.from('abc'), Buffer.from('def')]),
  }), /download limit/);
  assert.deepEqual(fs.readdirSync(directory), []);
});
