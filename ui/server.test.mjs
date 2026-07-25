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
const { APP_ROOT, APP_VERSION, UI_BUILD_ID, WORKSPACE_ROOT, createServer, operations, providerDetection, restartControl, shutdownControl } = await import('./server.mjs');
const { seedWorkspace, loadWorkspaceConfig, writeWorkspaceConfig } = await import('./lib/workspace.mjs');
const { acquireScanLock, releaseScanLock } = await import('../tools/scan-lock.mjs');

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

  const manifest = await request({ path: '/manifest.webmanifest' });
  assert.equal(manifest.headers['cache-control'], 'no-cache');
  assert.match(manifest.text, new RegExp(`scout-icon\\.png\\?v=${UI_BUILD_ID}`));
  assert.doesNotMatch(manifest.text, /__SCOUT_UI_BUILD__/);

  const worker = await request({ path: '/service-worker.js' });
  assert.equal(worker.headers['cache-control'], 'no-cache');
  assert.match(worker.text, new RegExp(`const BUILD = '${UI_BUILD_ID}'`));
  assert.doesNotMatch(worker.text, /__SCOUT_UI_BUILD__/);
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
  const config = loadWorkspaceConfig(WORKSPACE_ROOT);
  config.schedule.jobs = [{ id: 'claude-primary', enabled: true, time: '07:30', days: null, provider: 'claude', mode: 'primary', model: null }];
  writeWorkspaceConfig(WORKSPACE_ROOT, config);
  try {
    const response = await request({ method: 'POST', path: '/api/schedule', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', id: 'claude-primary', provider: 'claude', time: '09:15' }) });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).ok, true);
  } finally {
    await request({ method: 'POST', path: '/api/schedule', headers: { host, origin: `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', id: 'claude-primary' }) });
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
  const index = JSON.parse(response.text);
  assert.ok(index.applications.includes(slug));
  assert.deepEqual(index.entries.find((entry) => entry.slug === slug), {
    slug, source: true, pdf: false, pdfCurrent: false, pdfStale: false, renderedAt: null,
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
