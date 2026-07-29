import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PROVIDER_HEALTH_STATES,
  acknowledgeProviderAlert,
  classifyProviderHealth,
  providerPreflight,
  readProviderHealth,
  recordProviderHealth,
} from './providerHealth.mjs';

const STATES = [
  'checking',
  'ready',
  'credentials-present-unverified',
  'sign-in-required',
  'login-in-progress',
  'network-unavailable',
  'rate-limited',
  'cli-update-required',
  'provider-error',
];

const SIGNALS = [
  ['check-started', 'checking'],
  ['remote-success', 'ready'],
  ['local-credentials-present', 'credentials-present-unverified'],
  ['local-signed-out', 'sign-in-required'],
  ['login-started', 'login-in-progress'],
  ['network-failure', 'network-unavailable'],
  ['rate-limit', 'rate-limited'],
  ['cli-update', 'cli-update-required'],
  ['provider-failure', 'provider-error'],
  ['remote-auth-failure', 'sign-in-required'],
];

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-health-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

function at(index = 0) {
  return new Date(Date.UTC(2026, 6, 29, 9, 0, index)).toISOString();
}

function signal(kind, index = 0, source = 'startup') {
  return { kind, source, checkedAt: at(index) };
}

function healthFile(root, provider = 'codex') {
  return path.join(root, '.scout', 'provider-health', 'v1', `${provider}.json`);
}

test('exports the nine exact durable states and classifies every provider signal', () => {
  assert.deepEqual(Object.values(PROVIDER_HEALTH_STATES), STATES);
  assert.equal(Object.isFrozen(PROVIDER_HEALTH_STATES), true);
  for (const [kind, expected] of SIGNALS) {
    assert.equal(classifyProviderHealth({ kind }), expected);
  }
  assert.throws(() => classifyProviderHealth({ kind: 'mystery' }), /signal kind/i);
  assert.throws(
    () => classifyProviderHealth({ kind: 'remote-success', stdout: 'private output' }),
    /unsupported field/i,
  );
});

test('persists every state transition from the bounded signal vocabulary', (t) => {
  const root = temp(t);
  const transitions = SIGNALS.filter(([kind]) => kind !== 'remote-auth-failure');
  const observed = transitions.map(([kind], index) => recordProviderHealth(
    root,
    'codex',
    signal(kind, index),
    { purpose: 'startup' },
  ).state);
  assert.deepEqual(observed, transitions.map(([, state]) => state));
  assert.deepEqual(
    readProviderHealth(root, 'codex').history.map(({ state }) => state),
    observed,
  );
});

test('persists strict schema-v1 provider files with bounded atomic history', (t) => {
  const root = temp(t);
  for (let index = 0; index < 40; index += 1) {
    recordProviderHealth(
      root,
      'codex',
      signal(index % 2 ? 'remote-success' : 'network-failure', index),
      { purpose: 'startup' },
    );
  }

  const file = healthFile(root);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), [
    'alert', 'checkedAt', 'history', 'provider', 'reasonCode',
    'remoteAuthBarrier', 'schemaVersion', 'state', 'verified',
  ]);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.provider, 'codex');
  assert.equal(stored.history.length, 32);
  assert.deepEqual(Object.keys(stored.history[0]).sort(), [
    'at', 'purpose', 'reasonCode', 'source', 'state',
  ]);
  assert.ok(Buffer.byteLength(fs.readFileSync(file)) < 16 * 1024);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp')),
    [],
  );

  stored.unexpected = true;
  fs.writeFileSync(file, `${JSON.stringify(stored)}\n`, 'utf8');
  assert.throws(() => readProviderHealth(root, 'codex'), /unsupported schema/i);
});

test('remote authentication outranks local credentials but not distinct failures', (t) => {
  const root = temp(t);
  recordProviderHealth(root, 'codex', signal('remote-auth-failure'), {
    purpose: 'post-auth-failure',
  });
  let current = recordProviderHealth(
    root,
    'codex',
    signal('local-credentials-present', 1, 'post-auth'),
    { purpose: 'post-auth' },
  );
  assert.equal(current.state, 'sign-in-required');
  assert.equal(current.reasonCode, 'authentication-required');
  assert.equal(current.remoteAuthBarrier, true);

  current = recordProviderHealth(
    root,
    'codex',
    signal('network-failure', 2, 'periodic'),
    { purpose: 'periodic' },
  );
  assert.equal(current.state, 'network-unavailable');
  assert.equal(current.remoteAuthBarrier, true);

  current = recordProviderHealth(
    root,
    'codex',
    signal('remote-success', 3, 'post-auth'),
    { purpose: 'post-auth' },
  );
  assert.equal(current.state, 'ready');
  assert.equal(current.remoteAuthBarrier, false);
  assert.equal(current.verified, true);

  current = recordProviderHealth(
    root,
    'codex',
    signal('local-credentials-present', 4, 'startup'),
    { purpose: 'startup' },
  );
  assert.equal(current.state, 'credentials-present-unverified');
});

test('rejects scan-derived writes without a genuine current fence', (t) => {
  const root = temp(t);
  assert.throws(
    () => recordProviderHealth(
      root,
      'codex',
      signal('remote-success', 0, 'provider-operation'),
      { purpose: 'manual-run', lease: {} },
    ),
    /genuine current scan lease/i,
  );
  assert.equal(fs.existsSync(healthFile(root)), false);
});

test('keeps providers isolated and refuses raw or unbounded evidence', (t) => {
  const root = temp(t);
  recordProviderHealth(root, 'codex', signal('network-failure'), { purpose: 'startup' });
  recordProviderHealth(root, 'claude', signal('remote-success'), { purpose: 'startup' });
  assert.equal(readProviderHealth(root, 'codex').state, 'network-unavailable');
  assert.equal(readProviderHealth(root, 'claude').state, 'ready');

  const forbidden = [
    ['stdout', 'token=secret'],
    ['stderr', '/private/account/path'],
    ['body', '{"email":"owner@example.test"}'],
    ['credentials', 'secret'],
    ['account', 'owner@example.test'],
  ];
  for (const [key, value] of forbidden) {
    assert.throws(
      () => recordProviderHealth(
        root,
        'codex',
        { ...signal('provider-failure', 1), [key]: value },
        { purpose: 'startup' },
      ),
      /unsupported field/i,
    );
  }
  assert.throws(
    () => recordProviderHealth(
      root,
      'codex',
      { ...signal('provider-failure', 1), reasonCode: 'raw-private-provider-message' },
      { purpose: 'startup' },
    ),
    /reason code/i,
  );
  assert.doesNotMatch(fs.readFileSync(healthFile(root), 'utf8'), /secret|private|example\.test/i);
});

test('deduplicates durable alerts and supports explicit acknowledgement', async (t) => {
  const root = temp(t);
  const probe = async () => signal('rate-limit', 0, 'scheduled-preflight');
  const first = await providerPreflight(root, 'codex', 'scheduled-job', {
    probe,
    now: new Date(at(0)),
  });
  const second = await providerPreflight(root, 'codex', 'scheduled-job', {
    probe,
    now: new Date(at(1)),
  });
  assert.deepEqual(first, {
    ok: false,
    provider: 'codex',
    purpose: 'scheduled-job',
    state: 'rate-limited',
    reasonCode: 'rate-limited',
    checkedAt: at(0),
    verified: false,
    alertId: 'provider-health:codex:rate-limited',
    shouldNotify: true,
  });
  assert.equal(second.alertId, first.alertId);
  assert.equal(second.shouldNotify, false);

  const acknowledged = acknowledgeProviderAlert(root, 'codex', first.alertId, {
    now: new Date(at(2)),
  });
  assert.equal(acknowledged.alert.acknowledgedAt, at(2));
  const third = await providerPreflight(root, 'codex', 'scheduled-job', {
    probe,
    now: new Date(at(3)),
  });
  assert.equal(third.shouldNotify, false);
  assert.equal(third.alertId, first.alertId);
  assert.equal(readProviderHealth(root, 'codex').history.length, 3);
});

test('preflight allows only usable provider states and never substitutes providers', async (t) => {
  const root = temp(t);
  const codex = await providerPreflight(root, 'codex', 'manual-run', {
    probe: async () => signal('local-credentials-present', 0, 'manual-preflight'),
  });
  const claude = await providerPreflight(root, 'claude', 'scheduled-job', {
    probe: async () => signal('remote-auth-failure', 0, 'scheduled-preflight'),
  });
  assert.equal(codex.ok, true);
  assert.equal(codex.verified, false);
  assert.equal(codex.provider, 'codex');
  assert.equal(claude.ok, false);
  assert.equal(claude.provider, 'claude');
  assert.equal(readProviderHealth(root, 'codex').state, 'credentials-present-unverified');
  assert.equal(readProviderHealth(root, 'claude').state, 'sign-in-required');

  const retry = await providerPreflight(root, 'claude', 'retry', {
    probe: async () => signal('remote-success', 1, 'post-auth'),
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.provider, 'claude');
});

test('rejects unsupported providers, sources, purposes and unsafe time values', async (t) => {
  const root = temp(t);
  assert.throws(
    () => recordProviderHealth(root, '../outside', signal('check-started'), { purpose: 'startup' }),
    /provider/i,
  );
  assert.throws(
    () => recordProviderHealth(
      root,
      'codex',
      signal('check-started', 0, 'raw-command'),
      { purpose: 'startup' },
    ),
    /source/i,
  );
  assert.throws(
    () => recordProviderHealth(root, 'codex', signal('check-started'), { purpose: 'scan everything' }),
    /purpose/i,
  );
  assert.throws(
    () => recordProviderHealth(
      root,
      'codex',
      { kind: 'check-started', source: 'startup', checkedAt: 'yesterday' },
      { purpose: 'startup' },
    ),
    /timestamp/i,
  );
  await assert.rejects(
    providerPreflight(root, 'codex', 'unknown-purpose'),
    /purpose/i,
  );
});

test('refuses provider-health state redirected through a symlink or junction', (t) => {
  const root = temp(t);
  const outside = temp(t);
  fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, '.scout', 'provider-health'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return;
  }
  assert.throws(
    () => recordProviderHealth(root, 'codex', signal('check-started'), { purpose: 'startup' }),
    /symlink|junction|outside/i,
  );
  assert.equal(fs.existsSync(path.join(outside, 'v1', 'codex.json')), false);
});
