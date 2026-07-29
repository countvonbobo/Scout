import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const previousWorkspace = process.env.SCOUT_WORKSPACE;
const previousDeviceSettings = process.env.SCOUT_DEVICE_SETTINGS;
const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-server-test-'));
process.env.SCOUT_WORKSPACE = testWorkspace;
process.env.SCOUT_DEVICE_SETTINGS = path.join(testWorkspace, 'device-settings.json');
const {
  APP_ROOT, APP_VERSION, UI_BUILD_FILES, UI_BUILD_ID, WORKSPACE_ROOT,
  codexDeepLinkDetection, computeUiBuildId, createServer,
  inspectCodexDeepLinkHandler, operations, providerDetection, restartControl,
  shutdownControl,
} = await import('./server.mjs');
const { seedWorkspace, loadWorkspaceConfig, workspacePaths, writeWorkspaceConfig } = await import('./lib/workspace.mjs');
const { profileFingerprint } = await import('./lib/searchProfile.mjs');
const { acquireScanLock, releaseScanLock } = await import('../tools/scan-lock.mjs');
const { appendRunEvent, openRunJournal } = await import('./lib/runJournal.mjs');
const { acquireScanLease, currentLeaseOwner, releaseScanLease } = await import('./lib/scanLease.mjs');
const { enqueueScanRequest } = await import('./lib/scanQueue.mjs');

let server;
let port;

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (previousWorkspace === undefined) delete process.env.SCOUT_WORKSPACE;
  else process.env.SCOUT_WORKSPACE = previousWorkspace;
  if (previousDeviceSettings === undefined) delete process.env.SCOUT_DEVICE_SETTINGS;
  else process.env.SCOUT_DEVICE_SETTINGS = previousDeviceSettings;
  fs.rmSync(testWorkspace, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    if (Array.isArray(body)) {
      body.forEach((chunk) => req.write(chunk));
      req.end();
    } else req.end(body);
  });
}

const JSON_HEADERS = () => {
  const host = `127.0.0.1:${port}`;
  return { host, origin: `http://${host}`, 'content-type': 'application/json' };
};

function profileDraft() {
  return {
    version: 1,
    status: 'draft',
    target: {
      primaryTitles: [{ value: 'Researcher', strength: 'mandatory', provenance: 'explicit' }],
      locations: [{ value: 'Remote', strength: 'strong-preference', provenance: 'explicit' }],
      sectors: [{ value: 'Public interest', strength: 'nice-to-have', provenance: 'unconfirmed-inference' }],
    },
    negative: {
      excludedTitles: [{ value: 'Commission-only', strength: 'hard-exclusion', provenance: 'explicit' }],
      excludedResponsibilities: [],
    },
    compensation: {
      currency: 'GBP', period: 'year', minimum: 60000,
      minimumStrength: 'strong-preference', unknownPolicy: 'include',
    },
  };
}

test('search-profile routes review a complete draft and publish only the current confirmed version', async () => {
  seedWorkspace(APP_ROOT, testWorkspace);
  const paths = workspacePaths(WORKSPACE_ROOT);
  const legacyConfig = loadWorkspaceConfig(WORKSPACE_ROOT);
  legacyConfig.profile.displayName = 'Synthetic Person';
  legacyConfig.search.roleFamilies = ['Researcher'];
  legacyConfig.search.locations = ['Remote'];
  writeWorkspaceConfig(WORKSPACE_ROOT, legacyConfig);

  const incompleteStatus = await request({ method: 'GET', path: '/api/setup/status' });
  assert.equal(incompleteStatus.status, 200);
  assert.equal(fs.existsSync(paths.searchProfileDraft), false);

  fs.writeFileSync(paths.profileContext, 'Synthetic search-profile evidence. '.repeat(8), 'utf8');
  fs.writeFileSync(path.join(paths.profile, 'calibration.md'), 'Synthetic calibration evidence. '.repeat(5), 'utf8');
  fs.writeFileSync(path.join(paths.cv, 'master-cv.md'), 'Synthetic CV evidence. '.repeat(25), 'utf8');
  fs.mkdirSync(path.join(WORKSPACE_ROOT, '.scout', 'onboarding'), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, '.scout', 'onboarding', 'activated.json'), '{"approved":true}\n', 'utf8');
  const setupStatus = await request({ method: 'GET', path: '/api/setup/status' });
  assert.equal(setupStatus.status, 200);
  const migrated = await request({ method: 'GET', path: '/api/search-profile' });
  assert.equal(migrated.status, 200);
  assert.equal(JSON.parse(migrated.text).draft?.status, 'draft');
  assert.equal(fs.existsSync(paths.searchProfilePublished), false);

  const draft = profileDraft();
  fs.mkdirSync(path.dirname(paths.searchProfileDraft), { recursive: true });
  fs.writeFileSync(paths.searchProfileRaw, '{"source":"migration"}\n');
  fs.writeFileSync(paths.searchProfileDraft, `${JSON.stringify(draft)}\n`);
  const revision = profileFingerprint(draft);

  const reviewed = await request({ method: 'GET', path: '/api/search-profile' });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(JSON.parse(reviewed.text), {
    rawPresent: true, draft, published: null, draftRevision: revision,
  });

  const partial = await request({
    method: 'PUT', path: '/api/search-profile/draft', headers: JSON_HEADERS(),
    body: JSON.stringify({ draft: { status: 'draft' }, revision }),
  });
  assert.equal(partial.status, 400);

  const saved = await request({
    method: 'PUT', path: '/api/search-profile/draft', headers: JSON_HEADERS(),
    body: JSON.stringify({ draft, revision }),
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.text).draftRevision, revision);

  const unconfirmed = await request({
    method: 'POST', path: '/api/search-profile/publish', headers: JSON_HEADERS(),
    body: JSON.stringify({ revision, confirmed: false }),
  });
  assert.equal(unconfirmed.status, 409);

  const stale = await request({
    method: 'POST', path: '/api/search-profile/publish', headers: JSON_HEADERS(),
    body: JSON.stringify({ revision: 'stale', confirmed: true }),
  });
  assert.equal(stale.status, 409);

  const published = await request({
    method: 'POST', path: '/api/search-profile/publish', headers: JSON_HEADERS(),
    body: JSON.stringify({ revision, confirmed: true }),
  });
  assert.equal(published.status, 200);
  const result = JSON.parse(published.text);
  assert.match(result.published.id, /^profile-[a-f0-9]{12}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.searchProfilePublished, 'utf8')), result.published);
  assert.equal(loadWorkspaceConfig(WORKSPACE_ROOT).searchProfile.publishedId, result.published.id);
});

test('local server rejects a non-loopback Host header', async () => {
  const response = await request({ headers: { host: 'attacker.example' } });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: 'private remote access is not enabled for this address' });
});

test('production server remains loopback-only and never configures public Funnel access', () => {
  const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /server\.listen\(PORT, '127\.0\.0\.1'\)/);
  assert.doesNotMatch(source, /0\.0\.0\.0|tailscale funnel/i);
});

test('security headers protect pages and private APIs are never cacheable', async () => {
  const page = await request({ path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*'unsafe-inline'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  const api = await request({ path: '/api/app-info' });
  assert.equal(api.headers['cache-control'], 'no-store');
});

test('remote pages and APIs require the configured Tailscale owner', async () => {
  fs.writeFileSync(process.env.SCOUT_DEVICE_SETTINGS, JSON.stringify({
    schemaVersion: 2,
    remoteAccess: {
      enabled: true,
      ownerLogin: 'owner@example.com',
      origin: 'https://scout-host.example.ts.net',
      httpsPort: 443,
      managedMapping: { protocol: 'https', port: 443, target: 'http://127.0.0.1:8459' },
    },
  }));
  const missing = await request({ headers: { host: 'scout-host.example.ts.net' } });
  assert.equal(missing.status, 403);
  const wrong = await request({ headers: { host: 'scout-host.example.ts.net', 'tailscale-user-login': 'other@example.com' } });
  assert.equal(wrong.status, 403);
  const owner = await request({ path: '/api/app-info', headers: { host: 'scout-host.example.ts.net', 'tailscale-user-login': 'OWNER@example.com' } });
  assert.equal(owner.status, 200);
  assert.equal(JSON.parse(owner.text).name, 'Scout');
  assert.equal(owner.headers['strict-transport-security'], 'max-age=31536000');
  const alteredOrigin = await request({ path: '/api/app-info', headers: { host: 'scout-host.example.ts.net', origin: 'https://other.example.ts.net', 'tailscale-user-login': 'owner@example.com' } });
  assert.equal(alteredOrigin.status, 403);
});

test('Codex deep-link capability is device-local, bounded and private', async () => {
  let inspections = 0;
  codexDeepLinkDetection.inspect = async () => {
    inspections += 1;
    return {
      registered: false,
      registryPath: 'HKCU\\Software\\Classes\\codex',
      executable: 'C:\\Users\\private\\Codex.exe',
      error: 'person@example.test token=secret',
    };
  };
  const local = await request({ path: '/api/device/codex-deep-link' });
  assert.equal(local.status, 200);
  const localBody = JSON.parse(local.text);
  assert.equal(localBody.state, 'unavailable');
  assert.equal(localBody.canAttempt, false);
  assert.doesNotMatch(local.text, /registry|Users|person@|token|executable|error/i);

  const remote = await request({
    path: '/api/device/codex-deep-link',
    headers: { host: 'scout-host.example.ts.net', 'tailscale-user-login': 'owner@example.com' },
  });
  assert.equal(remote.status, 200);
  assert.equal(JSON.parse(remote.text).state, 'remote');
  assert.equal(inspections, 1);
});

test('Codex handler inspection uses only fixed read-only platform commands', async () => {
  const macCalls = [];
  const mac = await inspectCodexDeepLinkHandler({
    platform: 'darwin',
    run: async (command, args) => {
      macCalls.push([command, args]);
      return {
        status: 0,
        failed: false,
        timedOut: false,
        exceeded: false,
        stdout: '({ LSHandlerRoleAll = "com.openai.codex"; LSHandlerURLScheme = codex; })',
      };
    },
  });
  assert.deepEqual(mac, { registered: true });
  assert.deepEqual(macCalls, [[
    '/usr/bin/defaults',
    ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'],
  ]]);

  const windowsCalls = [];
  const windows = await inspectCodexDeepLinkHandler({
    platform: 'win32',
    run: async (command, args) => {
      windowsCalls.push([command, args]);
      return { status: windowsCalls.length === 2 ? 0 : 1, failed: false, timedOut: false, exceeded: false };
    },
  });
  assert.deepEqual(windows, { registered: true });
  assert.deepEqual(windowsCalls, [
    ['reg.exe', ['query', 'HKCU\\Software\\Classes\\codex\\shell\\open\\command', '/ve']],
    ['reg.exe', ['query', 'HKCR\\codex\\shell\\open\\command', '/ve']],
  ]);
});

test('remote owner mutations require HTTPS Origin and administration remains local-only', async () => {
  const remote = { host: 'scout-host.example.ts.net', 'tailscale-user-login': 'owner@example.com', 'content-type': 'application/json' };
  const noOrigin = await request({ method: 'POST', path: '/api/chat/stop', headers: remote, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const badOrigin = await request({ method: 'POST', path: '/api/chat/stop', headers: { ...remote, origin: 'https://changed.example.ts.net' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const backupRequired = await request({ method: 'POST', path: '/api/chat/stop', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: JSON.stringify({ id: 'none' }) });
  assert.equal(backupRequired.status, 409);
  assert.match(JSON.parse(backupRequired.text).error, /backup must be enabled/);
  fs.mkdirSync(path.join(testWorkspace, '.scout'), { recursive: true });
  fs.writeFileSync(path.join(testWorkspace, '.scout', 'sync.json'), JSON.stringify({ version: 1, enabled: true, remoteUrl: 'git@github.com:example/private.git' }));
  const ownerChat = await request({ method: 'POST', path: '/api/chat/stop', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: JSON.stringify({ id: 'none' }) });
  assert.equal(ownerChat.status, 200);
  const backupResolution = await request({
    method: 'POST',
    path: '/api/sync/resolve',
    headers: { ...remote, origin: 'https://scout-host.example.ts.net' },
    body: JSON.stringify({ analysisToken: '0'.repeat(64), confirmed: false }),
  });
  assert.equal(backupResolution.status, 409);
  assert.match(JSON.parse(backupResolution.text).error, /Confirm/);
  const localOnly = await request({ method: 'POST', path: '/api/remote-access/disable', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: '{}' });
  assert.equal(localOnly.status, 403);
  assert.match(JSON.parse(localOnly.text).error, /only be changed on the Scout host/);
  const adoption = await request({ method: 'POST', path: '/api/workspace/adopt-private', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: '{}' });
  assert.equal(adoption.status, 403);
  assert.match(JSON.parse(adoption.text).error, /only be changed on the Scout host/);
  const disableBackup = await request({ method: 'POST', path: '/api/sync/disable', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: '{}' });
  assert.equal(disableBackup.status, 403);
  assert.match(JSON.parse(disableBackup.text).error, /only be changed on the Scout host/);
  const rotatePassphrase = await request({ method: 'POST', path: '/api/sync/passphrase', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: '{}' });
  assert.equal(rotatePassphrase.status, 403);
  assert.match(JSON.parse(rotatePassphrase.text).error, /only be changed on the Scout host/);
  const remoteUpdate = await request({ method: 'POST', path: '/api/update/download', headers: { ...remote, origin: 'https://scout-host.example.ts.net' }, body: '{}' });
  assert.equal(remoteUpdate.status, 403);
});

test('backup divergence confirmation cannot acquire authority while a scan owns the fence', async () => {
  const active = acquireScanLease(testWorkspace, currentLeaseOwner(), {
    kind: 'scan', runId: 'active-scan-during-backup-resolution',
  });
  assert.ok(active);
  try {
    const response = await request({
      method: 'POST',
      path: '/api/sync/resolve',
      headers: JSON_HEADERS(),
      body: JSON.stringify({ analysisToken: '1'.repeat(64), confirmed: true }),
    });
    assert.equal(response.status, 409);
    assert.match(JSON.parse(response.text).error, /scan or workspace mutation is in progress/i);
  } finally {
    releaseScanLease(active);
  }
});

test('local device settings keep update downloads explicitly opt-in', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST', path: '/api/device/settings',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ updatePolicy: 'download' }),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).settings.updates.policy, 'download');
  const invalid = await request({
    method: 'POST', path: '/api/device/settings',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ updatePolicy: 'install-silently' }),
  });
  assert.equal(invalid.status, 400);
});

test('streamed chat endpoints reject missing Tailscale identity before opening SSE', async () => {
  const response = await request({
    method: 'POST', path: '/api/chat/send',
    headers: { host: 'scout-host.example.ts.net', origin: 'https://scout-host.example.ts.net', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'example', engine: 'codex', text: 'hello' }),
  });
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.headers['content-type'] || '', /event-stream/);
});

test('forwarding headers cannot turn local access into a remote request', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST', path: '/api/chat/stop',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json', 'x-forwarded-host': 'attacker.example', 'tailscale-user-login': 'other@example.com' },
    body: JSON.stringify({ id: 'none' }),
  });
  assert.equal(response.status, 200);
});

test('chat mutations reject a cross-origin browser request', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: {
      host: `127.0.0.1:${port}`,
      origin: 'https://attacker.example',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: 'same-origin request required' });
});

test('chat mutations reject a different Origin scheme on the same host', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: { host, origin: `https://${host}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.text), { error: 'same-origin request required' });
});

test('chat mutations require application/json', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(response.status, 415);
  assert.deepEqual(JSON.parse(response.text), { error: 'application/json required' });
});

test('normal same-origin JSON chat mutations still work', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST',
    path: '/api/chat/stop',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ id: 'no-running-turn' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { ok: true, stopped: false });
});

test('request JSON preserves UTF-8 characters split across network chunks', async () => {
  const host = `127.0.0.1:${port}`;
  const encoded = Buffer.from(JSON.stringify({ id: 'café-気候' }));
  const boundary = encoded.indexOf(Buffer.from('é')) + 1;
  const response = await request({
    method: 'POST', path: '/api/chat/stop',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    body: [encoded.subarray(0, boundary), encoded.subarray(boundary)],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { ok: true, stopped: false });
});

test('app identity reports the serving build and private workspace', async () => {
  const response = await request({ path: '/api/app-info' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    name: 'Scout', version: APP_VERSION, uiBuildId: UI_BUILD_ID, appRoot: APP_ROOT, workspaceRoot: WORKSPACE_ROOT,
  });
});

test('served shell and service worker receive the exact UI build id', async () => {
  const page = await request({ path: '/' });
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.match(page.text, new RegExp(`meta name="scout-ui-build" content="${UI_BUILD_ID}"`));
  assert.match(page.text, new RegExp(`app\\.js\\?v=${UI_BUILD_ID}`));
  assert.match(page.text, new RegExp(`scout-icon\\.png\\?v=${UI_BUILD_ID}`));
  assert.doesNotMatch(page.text, /__SCOUT_UI_BUILD__/);

  const app = await request({ path: `/app.js?v=${UI_BUILD_ID}` });
  assert.equal(app.headers['cache-control'], 'no-cache');
  assert.match(app.text, new RegExp(`chatDrawerState\\.mjs\\?v=${UI_BUILD_ID}`));
  assert.match(app.text, new RegExp(`codexDeepLink\\.mjs\\?v=${UI_BUILD_ID}`));
  assert.doesNotMatch(app.text, /__SCOUT_UI_BUILD__/);

  const manifest = await request({ path: '/manifest.webmanifest' });
  assert.equal(manifest.headers['cache-control'], 'no-cache');
  assert.match(manifest.text, new RegExp(`scout-icon\\.png\\?v=${UI_BUILD_ID}`));
  assert.doesNotMatch(manifest.text, /__SCOUT_UI_BUILD__/);

  const worker = await request({ path: '/service-worker.js' });
  assert.equal(worker.headers['cache-control'], 'no-cache');
  assert.match(worker.text, new RegExp(`const BUILD = '${UI_BUILD_ID}'`));
  assert.doesNotMatch(worker.text, /__SCOUT_UI_BUILD__/);
});

test('a change to the character module alone moves the UI build fingerprint', () => {
  const readOriginal = (name) => fs.readFileSync(path.join(APP_ROOT, 'ui', name));
  assert.equal(computeUiBuildId(readOriginal), UI_BUILD_ID);

  // Only ui/lib/scoutCharacter.mjs differs. If it were missing from the
  // fingerprint inputs, a module-only release would keep the old build id, the
  // old `scout-shell-<id>` cache and the old ?v= module URL, so installed PWAs
  // would go on running the previous character definitions.
  const mutated = computeUiBuildId((name) => (name === 'lib/scoutCharacter.mjs'
    ? Buffer.from('export const SCOUT_STATES = {};')
    : readOriginal(name)));
  assert.notEqual(mutated, UI_BUILD_ID);
  assert.ok(UI_BUILD_FILES.includes('lib/scoutCharacter.mjs'));
});

test('the served shell and offline cache both version the character module', async () => {
  const versioned = new RegExp(`/lib/scoutCharacter\\.mjs\\?v=${UI_BUILD_ID}`);
  const page = await request({ path: '/' });
  assert.match(page.text, versioned);

  // The worker interpolates BUILD itself, so the served copy proves the cached
  // module URL and the cache name both carry this build id.
  const worker = await request({ path: '/service-worker.js' });
  assert.match(worker.text, new RegExp(`const BUILD = '${UI_BUILD_ID}'`));
  assert.match(worker.text, /const CACHE = `scout-shell-\$\{BUILD\}`/);
  assert.match(worker.text, /`\/lib\/scoutCharacter\.mjs\?v=\$\{BUILD\}`/);
  assert.doesNotMatch(worker.text, /__SCOUT_UI_BUILD__/);

  const module = await request({ path: '/lib/scoutCharacter.mjs' });
  assert.equal(module.status, 200);
  assert.match(module.headers['content-type'], /text\/javascript/);
});

test('restart responds first, then schedules the respawn', async () => {
  const originalRespawn = restartControl.respawn;
  let respawned = false;
  restartControl.respawn = () => { respawned = true; };
  try {
    const host = `127.0.0.1:${port}`;
    const response = await request({
      method: 'POST',
      path: '/api/restart',
      headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { ok: true, restarting: true });
    assert.equal(respawned, false, 'respawn must happen after the response is sent');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(respawned, true);
  } finally {
    restartControl.respawn = originalRespawn;
  }
});

test('restart rejects a cross-origin browser request', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/restart',
    headers: { host: `127.0.0.1:${port}`, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 403);
});

test('restart waits for active operations and remote restart requires confirmation', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const operation = operations.start('restart-test', async () => blocker, { phase: 'Saving protected work' });
  const host = `127.0.0.1:${port}`;
  const blocked = await request({
    method: 'POST', path: '/api/restart',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(blocked.status, 409);
  const active = JSON.parse(blocked.text).active.operations;
  assert.equal(active.length, 1);
  assert.equal(active[0].id, operation.id);
  assert.equal(active[0].type, 'restart-test');
  assert.match(active[0].status, /^(queued|running)$/);
  assert.equal(active[0].phase, 'Saving protected work');
  release();
  const deadline = Date.now() + 500;
  while (operations.active('restart-test') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(operations.active('restart-test'), null);

  fs.writeFileSync(process.env.SCOUT_DEVICE_SETTINGS, JSON.stringify({
    schemaVersion: 2,
    remoteAccess: { enabled: true, ownerLogin: 'owner@example.com', origin: 'https://scout-host.example.ts.net' },
  }));
  const remoteHeaders = {
    host: 'scout-host.example.ts.net', origin: 'https://scout-host.example.ts.net',
    'tailscale-user-login': 'owner@example.com', 'content-type': 'application/json',
  };
  const unconfirmed = await request({ method: 'POST', path: '/api/restart', headers: remoteHeaders, body: '{}' });
  assert.equal(unconfirmed.status, 409);
  assert.match(JSON.parse(unconfirmed.text).error, /Confirm the remote restart/);
});

test('bounded setup mutations require same-origin JSON requests', async () => {
  const host = `127.0.0.1:${port}`;
  const wrongType = await request({
    method: 'POST', path: '/api/setup/proposal', headers: { host, origin: `http://${host}`, 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const crossOrigin = await request({
    method: 'POST', path: '/api/setup/activate', headers: { host, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
});

test('pending recovery keys require same-origin JSON requests', async () => {
  const host = `127.0.0.1:${port}`;
  const wrongType = await request({
    method: 'POST', path: '/api/sync/recovery-key',
    headers: { host, origin: `http://${host}`, 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const crossOrigin = await request({
    method: 'POST', path: '/api/sync/recovery-key',
    headers: { host, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
});

test('shutdown responds before scheduling process exit', async () => {
  const originalExit = shutdownControl.exit;
  let exited = false;
  shutdownControl.exit = () => { exited = true; };
  try {
    const host = `127.0.0.1:${port}`;
    const response = await request({
      method: 'POST',
      path: '/api/shutdown',
      headers: { host, origin: `http://${host}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { ok: true, shuttingDown: true });
    assert.equal(exited, false, 'exit must happen after the response is sent');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(exited, true);
  } finally {
    shutdownControl.exit = originalExit;
  }
});

test('shutdown rejects a cross-origin browser request', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/shutdown',
    headers: { host: `127.0.0.1:${port}`, origin: 'https://attacker.example' },
  });
  assert.equal(response.status, 403);
});

test('supervised scan requires a configured provider', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({ method: 'POST', path: '/api/scan', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /provider/i);
});

test('daily schedule is blocked before a healthy supervised scan', async () => {
  const host = `127.0.0.1:${port}`;
  const response = await request({ method: 'POST', path: '/api/schedule', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', provider: 'codex', time: '07:30' }) });
  assert.equal(response.status, 409);
  assert.match(JSON.parse(response.text).error, /healthy supervised scan/i);
});

test('an already-configured schedule job can be updated despite an unhealthy latest scan', async () => {
  const host = `127.0.0.1:${port}`;
  fs.mkdirSync(path.join(testWorkspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(testWorkspace, 'data', 'scan-runs.jsonl'), `${JSON.stringify({
    schemaVersion: 3, timestamp: '2020-01-01T09:00:00.000Z', started_at: '2020-01-01T08:53:00.000Z',
    agent: 'claude', mode: 'primary', degraded: true, skipped: true, candidates_found: 0, keepers_added: 0, keepers_updated: 0,
    discarded: {}, errors: ['stale/skipped run'], source_health: {}, queries_checked: [], reviewed: [],
  })}\n`);
  const originalConfig = loadWorkspaceConfig(WORKSPACE_ROOT);
  const config = loadWorkspaceConfig(WORKSPACE_ROOT);
  config.schedule.jobs = [{ id: 'claude-primary', enabled: true, time: '07:30', days: null, provider: 'claude', mode: 'primary', model: null }];
  writeWorkspaceConfig(WORKSPACE_ROOT, config);
  try {
    const response = await request({ method: 'POST', path: '/api/schedule', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', id: 'claude-primary', provider: 'claude', time: '09:15' }) });
    // The bug is the health gate itself, not whether the host's OS scheduler backend (systemd
    // user session / launchd Aqua session / Windows Task Scheduler) can actually register a job.
    // CI runners on Linux/macOS commonly cannot exercise that backend at all, so this asserts the
    // gate specifically -- never a 409 with the "healthy supervised scan" error -- rather than a
    // blanket 200, keeping the test deterministic regardless of OS scheduler availability.
    assert.notEqual(response.status, 409);
    const parsed = JSON.parse(response.text);
    assert.doesNotMatch(parsed.error || '', /healthy supervised scan/i);
  } finally {
    // Best-effort cleanup of any real OS scheduler artifact the install above may have created.
    // Its outcome is deliberately not asserted: on hosts without a usable scheduler backend this
    // call itself cannot succeed, and that must not fail the test.
    await request({ method: 'POST', path: '/api/schedule', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', id: 'claude-primary' }) }).catch(() => {});
    // Deterministically restore workspace config regardless of whether the OS-level remove above
    // succeeded, so no stray schedule job entry leaks into later tests in this file.
    writeWorkspaceConfig(WORKSPACE_ROOT, originalConfig);
    fs.rmSync(path.join(testWorkspace, 'data', 'scan-runs.jsonl'), { force: true });
  }
});

test('first enablement of an unconfigured schedule job is still blocked when unhealthy', async () => {
  const host = `127.0.0.1:${port}`;
  fs.mkdirSync(path.join(testWorkspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(testWorkspace, 'data', 'scan-runs.jsonl'), `${JSON.stringify({
    schemaVersion: 3, timestamp: '2020-01-01T09:00:00.000Z', started_at: '2020-01-01T08:53:00.000Z',
    agent: 'claude', mode: 'primary', degraded: true, skipped: true, candidates_found: 0, keepers_added: 0, keepers_updated: 0,
    discarded: {}, errors: ['stale/skipped run'], source_health: {}, queries_checked: [], reviewed: [],
  })}\n`);
  try {
    const response = await request({ method: 'POST', path: '/api/schedule', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', id: 'codex-verify', provider: 'codex', time: '07:30' }) });
    assert.equal(response.status, 409);
    assert.match(JSON.parse(response.text).error, /healthy supervised scan/i);
  } finally {
    fs.rmSync(path.join(testWorkspace, 'data', 'scan-runs.jsonl'), { force: true });
  }
});

test('latest scan API exposes only bounded review fields and scan health omits raw queries', async () => {
  fs.mkdirSync(path.join(testWorkspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(testWorkspace, 'data', 'scan-runs.jsonl'), `${JSON.stringify({
    schemaVersion: 3, timestamp: '2026-07-22T10:00:00.000Z', started_at: '2026-07-22T09:53:00.000Z',
    agent: 'codex', mode: 'primary', degraded: false, skipped: false, candidates_found: 1, keepers_added: 0, keepers_updated: 0,
    discarded: { provider_discarded: 1 }, errors: [], source_health: {}, queries_checked: ['private query'],
    reviewed: [{
      company: 'Synthetic Company', role: 'Synthetic Role', source: 'synthetic', sourceUrl: 'https://example.test/job',
      outcome: 'provider_discarded', score: 45, reasons: ['Concise reason'], description: 'full advert',
      profileEvidence: 'private evidence', prompt: 'provider prompt',
    }],
  })}\n`);
  const latest = await request({ path: '/api/scans/latest' });
  assert.equal(latest.status, 200);
  const text = latest.text;
  assert.match(text, /Synthetic Company/);
  assert.doesNotMatch(text, /private query|full advert|private evidence|provider prompt/);
  const health = await request({ path: '/api/scan-health' });
  assert.doesNotMatch(health.text, /private query/);
  const storage = JSON.parse(health.text).storagePressure;
  assert.equal(['healthy', 'warning', 'blocked'].includes(storage.state), true);
  assert.deepEqual(Object.keys(storage.totals).sort(), ['artifacts', 'queue', 'runs', 'totalBytes']);
  assert.doesNotMatch(JSON.stringify(storage), /private-run|scan-lease|workspace/i);
});

test('latest scan API exposes reconciled metrics and bounded explanations only', async () => {
  fs.mkdirSync(path.join(testWorkspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(testWorkspace, 'data', 'scan-runs.jsonl'), `${JSON.stringify({
    schemaVersion: 4, timestamp: '2026-07-26T10:00:00.000Z', agent: 'codex', mode: 'primary', errors: [],
    profile_id: 'profile-123456789abc', discovery_engine: 'ranked-discovery',
    funnel: { sourceRecords: 2532, sourceErrors: 2, failedSourceRecords: 3, uniqueVacancies: 120, deterministicallyExcluded: 40, eligible: 80, ranked: 80, selected: 60, assessed: 59, assessmentFailed: 1 },
    explanations: [{ vacancy_id: 'vacancy-1', pre_rank: { score: 82, positive: [{ code: 'title', score: 4, raw: 'private payload' }], negative: [{ code: 'negative', score: -1, path: 'C:\\private' }] }, selection_reason: 'score-band', assessment_status: 'assessed', source: 'ats', sourceUrl: 'https://example.test/job', raw: 'private payload', path: 'C:\\private' }],
  })}\n`);
  const response = await request({ path: '/api/scans/latest' });
  assert.equal(response.status, 200);
  assert.match(response.text, /Source records|2532|profile-123456789abc|vacancy-1/);
  const latest = JSON.parse(response.text).scan;
  assert.equal(latest.funnel.sourceErrors, 2);
  assert.equal(latest.funnel.failedSourceRecords, 3);
  assert.doesNotMatch(response.text, /private payload|C:\\private/);
});

test('latest scan API bounds source URLs in persisted explanation records', async () => {
  fs.mkdirSync(path.join(testWorkspace, 'data'), { recursive: true });
  const oversizedUrl = `https://example.test/job?${'x'.repeat(5000)}`;
  fs.writeFileSync(path.join(testWorkspace, 'data', 'scan-runs.jsonl'), `${JSON.stringify({ timestamp: '2026-07-26T10:00:00.000Z', explanations: [{ vacancy_id: 'vacancy-1', pre_rank: {}, assessment_status: 'assessed', source: 'ats', sourceUrl: oversizedUrl }] })}\n`);
  const response = await request({ path: '/api/scans/latest' });
  const { scan } = JSON.parse(response.text);
  assert.equal(scan.explanations[0].sourceUrl, null);
});

test('run and queue APIs expose journal-backed state through privacy-safe summaries', async () => {
  const runId = 'run-1234567890-private';
  const lease = acquireScanLease(testWorkspace, currentLeaseOwner(), { kind: 'scan', runId });
  try {
    const journal = openRunJournal(testWorkspace, runId);
    appendRunEvent(journal, {
      type: 'run.started', stageId: 'initialise', idempotencyKey: 'run-started',
      payload: {
        schemaVersion: 1,
        compatibility: {
          schemaVersion: 1, mode: 'primary', purpose: 'job-discovery',
          profileVersion: 'profile-v3', sourceConfigFingerprint: 'a'.repeat(64),
          journalSchemaVersion: 1, artifactSchemaVersion: 1,
          pipelineVersion: 'pipeline-v9', rankingVersion: 'ranking-v1',
          promptVersion: 'prompt-v1', assessmentSchemaVersion: 1,
          provider: 'codex', model: 'gpt-5', mutationSchemaVersion: 1,
          targetRevision: 'tracker-v1',
        },
      },
    }, lease);
    appendRunEvent(journal, {
      type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-completed',
      payload: { schemaVersion: 1, reference: { kind: 'stage', id: 'collect' }, count: 12 },
    }, lease);
    enqueueScanRequest(testWorkspace, {
      id: 'request-1234567890-private', key: 'manual-discovery',
      requester: 'manual', purpose: 'job-discovery',
      requestedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-30T00:00:00.000Z',
      windowAt: null,
      compatibility: {
        profileFingerprint: 'b'.repeat(64), configFingerprint: 'c'.repeat(64), schemaVersion: 1,
      },
      lease,
    });

    const runsResponse = await request({ path: '/api/scan/runs' });
    const queueResponse = await request({ path: '/api/scan/queue' });
    assert.equal(runsResponse.status, 200);
    assert.equal(queueResponse.status, 200);
    const runs = JSON.parse(runsResponse.text);
    const queue = JSON.parse(queueResponse.text);
    assert.equal(runs.runs[0].id, 'run-1234…');
    assert.equal(runs.runs[0].state, 'normalising');
    assert.equal(runs.runs[0].owner, 'active worker');
    assert.equal(queue.requests[0].id, 'request-…');
    assert.equal(queue.requests[0].status, 'queued');
    for (const text of [runsResponse.text, queueResponse.text]) {
      assert.doesNotMatch(text, /run-1234567890-private|request-1234567890-private/i);
      assert.doesNotMatch(text, new RegExp(currentLeaseOwner().host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      assert.doesNotMatch(text, new RegExp(String(process.pid)));
      assert.doesNotMatch(text, /profileFingerprint|configFingerprint|sourceConfigFingerprint|targetRevision/i);
    }
  } finally {
    releaseScanLease(lease);
    fs.rmSync(path.join(testWorkspace, '.scout', 'runs'), { recursive: true, force: true });
    fs.rmSync(path.join(testWorkspace, '.scout', 'scan-queue.jsonl'), { force: true });
  }
});

test('legacy CV downloads require a hash-bound explicit override', async () => {
  const slug = 'synthetic-quality';
  const app = path.join(testWorkspace, 'applications', slug);
  fs.mkdirSync(app, { recursive: true });
  const source = '#show: cv.with(name: "Example")\n';
  const pdf = '%PDF-1.7\nsynthetic valid pdf body';
  fs.writeFileSync(path.join(app, 'cv.typ'), source);
  fs.writeFileSync(path.join(app, 'cv.pdf'), pdf);
  fs.mkdirSync(path.join(testWorkspace, '.scout'), { recursive: true });
  fs.writeFileSync(path.join(testWorkspace, '.scout', 'cv-renders.json'), JSON.stringify({
    schemaVersion: 1,
    renders: { [`application:${slug}`]: { sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), renderedAt: '2026-07-22T10:00:00.000Z' } },
  }));

  const qualityResponse = await request({ path: `/api/cv/quality?slug=${slug}` });
  assert.equal(qualityResponse.status, 200);
  const quality = JSON.parse(qualityResponse.text);
  assert.equal(quality.status, 'legacy');

  const denied = await request({ path: `/api/cv/pdf?slug=${slug}&download=1` });
  assert.equal(denied.status, 409);
  assert.equal(JSON.parse(denied.text).overridable, true);

  const host = `127.0.0.1:${port}`;
  const accepted = await request({
    method: 'POST', path: '/api/cv/quality/override',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug, cvSha256: quality.cvSha256 }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.text).status, 'overridden');

  const downloaded = await request({ path: `/api/cv/pdf?slug=${slug}&download=1` });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.text, pdf);
  assert.equal(downloaded.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(downloaded.headers['content-security-policy'], /frame-ancestors 'self'/);
});

test('stale CV PDFs are not served after their source changes', async () => {
  const slug = 'synthetic-quality';
  fs.appendFileSync(path.join(testWorkspace, 'applications', slug, 'cv.typ'), '\n= Changed\n');
  const response = await request({ path: `/api/cv/pdf?slug=${slug}` });
  assert.equal(response.status, 409);
  assert.match(JSON.parse(response.text).error, /stale/i);
});

test('CV index keeps legacy sources visible and describes missing derived files', async () => {
  const slug = 'legacy-visible';
  const app = path.join(testWorkspace, 'applications', slug);
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'cv.typ'), '= Legacy source\n');
  const response = await request({ path: '/api/cv' });
  assert.equal(response.status, 200);
  const cvs = JSON.parse(response.text);
  assert.ok(cvs.applications.includes(slug));
  assert.deepEqual(cvs.entries.find((entry) => entry.slug === slug), {
    slug: 'legacy-visible', source: true, pdf: false, pdfCurrent: false, pdfStale: false, restored: false, renderedAt: null,
    outreach: false, evidence: false, quality: false,
  });
});

test('a slow setup provider probe does not delay unrelated API requests', { concurrency: false }, async () => {
  seedWorkspace(APP_ROOT, testWorkspace);
  const original = providerDetection.detect;
  let release;
  providerDetection.detect = () => new Promise((resolve) => { release = resolve; });
  try {
    const slowStatus = request({ path: '/api/setup/status' });
    await assert.doesNotReject(async () => {
      const deadline = Date.now() + 200;
      while (!release && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
      if (!release) throw new Error('provider probe did not start');
    });
    const started = performance.now();
    const appInfo = await request({ path: '/api/app-info' });
    const elapsed = performance.now() - started;
    assert.equal(appInfo.status, 200);
    assert.ok(elapsed < 100, `unrelated API took ${elapsed.toFixed(1)}ms while provider status was pending`);
    release({
      codex: { installed: true, authenticated: true, capabilities: { structuredOutput: true } },
      claude: { installed: false, authenticated: false },
    });
    assert.equal((await slowStatus).status, 200);
  } finally {
    providerDetection.detect = original;
  }
});

test('POST /api/status accepts the shortlist status and persists it', async () => {
  seedWorkspace(APP_ROOT, testWorkspace);
  const trackerFile = path.join(testWorkspace, 'data', 'opportunities.json');
  const id = 'shortlist-test-2026-07';
  const original = {
    updated: '2026-07-24',
    opportunities: [{
      id, company: 'Shortlist Test', role: 'Engineer', status: 'new', score: 75,
      category: 'startup', notes: '', contacts: [], log: [],
    }],
  };
  fs.writeFileSync(trackerFile, `${JSON.stringify(original, null, 2)}\n`);
  const before = JSON.parse((await request({ path: '/api/opportunities' })).text);

  const host = `127.0.0.1:${port}`;
  const response = await request({
    method: 'POST', path: '/api/status',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id, status: 'shortlist', trackerRevision: before.trackerRevision }),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).ok, true);

  const saved = JSON.parse(fs.readFileSync(trackerFile, 'utf8')).opportunities[0];
  assert.equal(saved.status, 'shortlist');
});

test('a UI mutation racing scan completion preserves every tracked user field', { concurrency: false }, async () => {
  seedWorkspace(APP_ROOT, testWorkspace);
  const trackerFile = path.join(testWorkspace, 'data', 'opportunities.json');
  const id = 'race-example-2026-07';
  const original = {
    updated: '2026-07-22',
    opportunities: [{
      id, company: 'Race Example', role: 'Engineer', status: 'interviewing', score: 70,
      category: 'startup', notes: '[2026-07-20] Existing note',
      contacts: [{ name: 'Alex', role: 'Hiring manager', linkedin: '', foundVia: 'event' }],
      commute: { originPostcode: 'SW1A 1AA', carMinutes: 35, publicTransportMinutes: 42 },
      application: { appliedAt: '2026-07-19', stages: [{ name: 'Screen', completed: true, completedAt: '2026-07-21' }] },
      log: [],
    }],
  };
  fs.writeFileSync(trackerFile, `${JSON.stringify(original, null, 2)}\n`);
  const before = JSON.parse((await request({ path: '/api/opportunities' })).text);
  const scanLock = acquireScanLock(testWorkspace, { agent: 'test-scan', mode: 'primary' });
  assert.equal(scanLock.ok, true);

  const mutation = request({
    method: 'POST', path: '/api/note',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, text: 'Arrived during scan completion', trackerRevision: before.trackerRevision }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const scanned = structuredClone(original);
  scanned.updated = '2026-07-23';
  scanned.opportunities[0].score = 84;
  const temporary = `${trackerFile}.scan-test`;
  fs.writeFileSync(temporary, `${JSON.stringify(scanned, null, 2)}\n`);
  fs.renameSync(temporary, trackerFile);
  releaseScanLock(testWorkspace, scanLock.lock.token);

  const conflict = await mutation;
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.text).conflict, true);
  const refreshed = JSON.parse((await request({ path: '/api/opportunities' })).text);
  const retry = await request({
    method: 'POST', path: '/api/note',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, text: 'Arrived during scan completion', trackerRevision: refreshed.trackerRevision }),
  });
  assert.equal(retry.status, 200);

  const saved = JSON.parse(fs.readFileSync(trackerFile, 'utf8')).opportunities[0];
  assert.equal(saved.score, 84);
  assert.equal(saved.status, original.opportunities[0].status);
  assert.equal(saved.category, original.opportunities[0].category);
  assert.deepEqual(saved.contacts, original.opportunities[0].contacts);
  assert.deepEqual(saved.commute, original.opportunities[0].commute);
  assert.deepEqual(saved.application, original.opportunities[0].application);
  assert.match(saved.notes, /Existing note/);
  assert.match(saved.notes, /Arrived during scan completion/);
});
