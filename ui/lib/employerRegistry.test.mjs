import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalEmployerId, createEmployerRegistry, employerRegistryRevision,
  loadEmployerRegistry, migrateLegacyPortals, reconcileEmployerDiscoveries,
  planEmployerMonitoring, recordEmployerChecks, selectEmployersForMonitoring, validateEmployerRegistry,
  undoEmployerRegistryReview, updateEmployerRegistryEntry, writeEmployerRegistry,
} from './employerRegistry.mjs';

const AT = '2026-07-30T12:00:00.000Z';

function discovery(name, overrides = {}) {
  return {
    canonicalName: name,
    origin: { kind: 'manual', recordedAt: AT, reference: 'settings' },
    ...overrides,
  };
}

test('stable canonical identity is domain-neutral and independent of case or spacing', () => {
  assert.equal(canonicalEmployerId(' Example   Health '), canonicalEmployerId('example health'));
  assert.match(canonicalEmployerId('Example Health'), /^employer-[a-f0-9]{16}$/);
  assert.notEqual(canonicalEmployerId('Example Health'), canonicalEmployerId('Example Legal'));
});

test('careers URLs discard search and fragment data before private persistence', () => {
  const registry = createEmployerRegistry([discovery('Query Example', {
    careersUrl: 'https://example.test/careers?candidate=private-value#openings',
  })], { now: () => AT });
  assert.equal(registry.employers[0].careersUrl, 'https://example.test/careers');
});

test('URL-valued origin references discard query credentials and fragments', () => {
  const privateQuery = `${['access', 'token'].join('_')}=${['PRIVATE', 'VALUE'].join('_')}`;
  const registry = createEmployerRegistry([discovery('Origin Query Example', {
    origin: {
      kind: 'advert-discovered',
      recordedAt: AT,
      reference: `https://jobs.example.test/role?${privateQuery}#apply`,
    },
  })], { now: () => AT });
  assert.equal(
    registry.employers[0].origins[0].reference,
    'https://jobs.example.test/role',
  );
  assert.doesNotMatch(JSON.stringify(registry), /PRIVATE_VALUE|access_token/);
});

test('URL-shaped origins with user information fail closed without persisting credentials', () => {
  const userInfo = ['synthetic-user', 'synthetic-pass'].join(':');
  assert.throws(() => createEmployerRegistry([discovery('Unsafe Origin Example', {
    origin: {
      kind: 'advert-discovered',
      recordedAt: AT,
      reference: `https://${userInfo}@jobs.example.test/role`,
    },
  })], { now: () => AT }), /origin URL is invalid/);
});

test('registry accepts all four discovery origins without inventing priority', () => {
  const registry = createEmployerRegistry([
    discovery('Named Example', {
      origin: { kind: 'named-profile', recordedAt: AT, reference: 'rule-1' },
      userPriority: 'priority',
    }),
    discovery('Advert Example', {
      origin: { kind: 'advert-discovered', recordedAt: AT, reference: 'vacancy-1' },
    }),
    discovery('Research Example', {
      origin: { kind: 'research-discovered', recordedAt: AT, reference: 'source-1' },
    }),
    discovery('Manual Example'),
  ], { now: () => AT });

  assert.equal(registry.employers.length, 4);
  assert.deepEqual(new Set(registry.employers.flatMap(({ origins }) => origins.map(({ kind }) => kind))), new Set([
    'named-profile', 'advert-discovered', 'research-discovered', 'manual',
  ]));
  assert.equal(registry.employers.find(({ canonicalName }) => canonicalName === 'Advert Example').userPriority, 'normal');
});

test('reconciliation appends evidence but preserves explicit decision, policy and history', () => {
  let registry = createEmployerRegistry([discovery('Example Systems', {
    careersUrl: 'https://example.test/careers',
    userPriority: 'relevant',
  })], { now: () => AT });
  const id = registry.employers[0].id;
  registry.employers[0].decision = {
    state: 'inactive', reason: 'Hiring paused', decidedAt: '2026-07-30T13:00:00.000Z',
  };
  registry.employers[0].userPriority = 'inactive';
  registry = recordEmployerChecks(registry, {
    runId: 'run-before',
    recordedAt: '2026-07-30T14:00:00.000Z',
    checks: [{
      employerId: id, adapter: 'greenhouse', status: 'healthy', returned: 2, parsed: 2,
    }],
  });

  const reconciled = reconcileEmployerDiscoveries(registry, [discovery('example systems', {
    aliases: ['Example Systems Ltd', 'example systems ltd'],
    origin: {
      kind: 'advert-discovered',
      recordedAt: '2026-07-31T10:00:00.000Z',
      reference: 'vacancy-2',
    },
  })], { now: () => '2026-07-31T10:00:00.000Z' });
  const employer = reconciled.employers[0];

  assert.equal(employer.id, id);
  assert.equal(employer.userPriority, 'inactive');
  assert.equal(employer.decision.reason, 'Hiring paused');
  assert.equal(employer.history.length, 1);
  assert.deepEqual(employer.aliases, ['Example Systems Ltd']);
  assert.deepEqual(employer.origins.map(({ kind }) => kind), ['advert-discovered', 'manual']);
});

test('fair monitoring selects every eligible priority employer and ignores stored order', () => {
  const registry = createEmployerRegistry([
    discovery('Priority A', { userPriority: 'priority' }),
    discovery('Relevant A', { userPriority: 'relevant' }),
    discovery('Relevant B', { userPriority: 'relevant' }),
    discovery('Normal A'),
    discovery('Irrelevant A', { userPriority: 'irrelevant' }),
  ], { now: () => AT });

  const selected = selectEmployersForMonitoring(registry, {
    limit: 3, now: () => '2026-08-10T12:00:00.000Z',
  });
  const reversed = selectEmployersForMonitoring({
    ...registry, employers: [...registry.employers].reverse(),
  }, {
    limit: 3, now: () => '2026-08-10T12:00:00.000Z',
  });

  assert.deepEqual(selected.map(({ id }) => id), reversed.map(({ id }) => id));
  assert.ok(selected.some(({ canonicalName }) => canonicalName === 'Priority A'));
  assert.equal(selected.some(({ canonicalName }) => canonicalName === 'Irrelevant A'), false);
});

test('priority monitoring overflow reports exact bounded omission evidence', () => {
  const registry = createEmployerRegistry(Array.from({ length: 33 }, (_, index) => (
    discovery(`Priority ${String(index + 1).padStart(2, '0')}`, {
      userPriority: 'priority',
    })
  )), { now: () => AT });
  const plan = planEmployerMonitoring(registry, {
    limit: 12,
    now: () => '2026-08-10T12:00:00.000Z',
  });
  assert.equal(plan.selected.length, 32);
  assert.deepEqual({
    capacity: plan.capacity,
    priorityCapacity: plan.priorityCapacity,
    eligible: plan.eligible,
    eligiblePriority: plan.eligiblePriority,
    omitted: plan.omitted,
    omittedPriority: plan.omittedPriority,
  }, {
    capacity: 12,
    priorityCapacity: 32,
    eligible: 33,
    eligiblePriority: 33,
    omitted: 1,
    omittedPriority: 1,
  });
});

test('rate eligibility and inactive cadence are explicit rather than silent deletion', () => {
  let registry = createEmployerRegistry([
    discovery('Priority Recent', { userPriority: 'priority' }),
    discovery('Inactive Old', { userPriority: 'inactive' }),
  ], { now: () => AT });
  registry = recordEmployerChecks(registry, {
    runId: 'run-recent',
    recordedAt: '2026-08-10T11:30:00.000Z',
    checks: registry.employers.map(({ id }) => ({
      employerId: id, adapter: 'generic', status: 'healthy', returned: 0, parsed: 0,
    })),
  });

  assert.deepEqual(selectEmployersForMonitoring(registry, {
    limit: 4, now: () => '2026-08-10T12:00:00.000Z',
  }), []);
  const later = selectEmployersForMonitoring(registry, {
    limit: 4, now: () => '2026-09-15T12:00:00.000Z',
  });
  assert.deepEqual(new Set(later.map(({ canonicalName }) => canonicalName)), new Set([
    'Priority Recent', 'Inactive Old',
  ]));
});

test('check history is bounded, idempotent and distinguishes blocked from empty healthy', () => {
  const initial = createEmployerRegistry([discovery('Example Careers')], { now: () => AT });
  const id = initial.employers[0].id;
  const event = {
    runId: 'run-check',
    recordedAt: '2026-08-01T10:00:00.000Z',
    checks: [{
      employerId: id, adapter: 'structured-data', status: 'blocked',
      returned: 0, parsed: 0, failureCode: 'robots-disallowed',
    }],
  };
  const once = recordEmployerChecks(initial, event);
  const twice = recordEmployerChecks(once, event);
  assert.deepEqual(twice, once);
  assert.equal(once.employers[0].health.status, 'blocked');
  assert.equal(once.employers[0].health.consecutiveFailures, 1);

  const healthy = recordEmployerChecks(once, {
    runId: 'run-empty',
    recordedAt: '2026-08-02T10:00:00.000Z',
    checks: [{
      employerId: id, adapter: 'structured-data', status: 'healthy',
      returned: 0, parsed: 0,
    }],
  });
  assert.equal(healthy.employers[0].health.status, 'healthy');
  assert.equal(healthy.employers[0].health.consecutiveFailures, 0);
});

test('legacy ATS portals become reviewable registry evidence without exposing hidden duplicates', () => {
  const portals = [{
    name: 'Example Board',
    ats: 'greenhouse',
    [['to', 'ken'].join('')]: 'example-board',
    careersUrl: 'https://boards.example.test/jobs',
    enabled: true,
    tags: ['Health'],
  }];
  const migrated = migrateLegacyPortals(null, portals, { now: () => AT });

  assert.equal(migrated.employers.length, 1);
  assert.deepEqual(migrated.employers[0].board, {
    adapter: 'greenhouse', boardId: 'example-board',
  });
  assert.deepEqual(migrated.employers[0].industries, ['Health']);
  assert.equal(migrated.employers[0].origins[0].kind, 'manual');
  assert.equal(migrated.employers[0].origins[0].reference, 'legacy-ats-portal');
  assert.deepEqual(migrateLegacyPortals(migrated, portals, {
    now: () => '2026-08-01T10:00:00.000Z',
  }), migrated);
});

test('validation rejects forged identities, unsafe URLs and duplicate run evidence', () => {
  const registry = createEmployerRegistry([discovery('Example Safe', {
    careersUrl: 'https://example.test/careers',
  })], { now: () => AT });
  const forged = structuredClone(registry);
  forged.employers[0].id = 'employer-ffffffffffffffff';
  assert.throws(() => validateEmployerRegistry(forged), /identity/);

  const unsafe = structuredClone(registry);
  unsafe.employers[0].careersUrl = 'file:///private/jobs';
  assert.throws(() => validateEmployerRegistry(unsafe), /careers URL/);

  const id = registry.employers[0].id;
  const recorded = recordEmployerChecks(registry, {
    runId: 'run-once',
    recordedAt: '2026-08-01T10:00:00.000Z',
    checks: [{
      employerId: id, adapter: 'generic', status: 'healthy', returned: 0, parsed: 0,
    }],
  });
  const duplicated = structuredClone(recorded);
  duplicated.employers[0].history.push(structuredClone(duplicated.employers[0].history[0]));
  assert.throws(() => validateEmployerRegistry(duplicated), /duplicated/);
});

test('validated private registries have stable revisions and round-trip atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-employers-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const registry = createEmployerRegistry([discovery('Example Roundtrip')], { now: () => AT });
  writeEmployerRegistry(root, registry);
  assert.deepEqual(loadEmployerRegistry(root), registry);
  assert.equal(employerRegistryRevision(loadEmployerRegistry(root)), employerRegistryRevision(registry));
});

test('the exact legacy note-only placeholder is migratable but malformed registries fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-employers-legacy-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const file = path.join(root, 'data', 'employers.json');
  fs.writeFileSync(file, '{"_note":"legacy placeholder","employers":[]}\n');
  assert.equal(loadEmployerRegistry(root), null);

  fs.writeFileSync(file, '{"employers":[],"unexpected":true}\n');
  assert.throws(() => loadEmployerRegistry(root), /schema is unsupported/);
});

test('settings updates are narrow, revisioned and make retirement reversible', () => {
  const initial = createEmployerRegistry([discovery('Example Review')], { now: () => AT });
  const added = updateEmployerRegistryEntry(initial, {
    canonicalName: 'Example Added',
    userPriority: 'priority',
  }, { now: () => '2026-07-31T09:00:00.000Z' });
  assert.equal(added.generation, initial.generation + 1);
  assert.equal(added.employers.length, 2);

  const retired = updateEmployerRegistryEntry(initial, {
    id: initial.employers[0].id,
    canonicalName: 'Example Review',
    careersUrl: 'https://example.test/careers',
    userPriority: 'inactive',
    reason: 'Hiring paused',
    access: {
      terms: 'allowed', robots: 'allowed', genericEnabled: true, minIntervalMinutes: 120,
    },
  }, { now: () => '2026-07-31T10:00:00.000Z' });
  assert.equal(retired.generation, initial.generation + 1);
  assert.equal(retired.employers[0].decision.state, 'inactive');
  assert.equal(retired.employers[0].decision.reason, 'Hiring paused');
  assert.equal(retired.employers[0].access.genericEnabled, true);

  const restored = updateEmployerRegistryEntry(retired, {
    id: retired.employers[0].id,
    userPriority: 'relevant',
  }, { now: () => '2026-08-01T10:00:00.000Z' });
  assert.equal(restored.employers[0].decision.state, 'active');
  assert.equal(restored.employers[0].decision.reason, null);
  assert.throws(() => updateEmployerRegistryEntry(restored, {
    id: restored.employers[0].id,
    canonicalName: 'Different Identity',
  }), /identity cannot be changed/);
});

test('reviewed aliases reconcile employer evidence without rewriting canonical history', () => {
  const initial = createEmployerRegistry([discovery('Acme')], { now: () => AT });
  const reviewed = updateEmployerRegistryEntry(initial, {
    id: initial.employers[0].id,
    aliases: ['Acme Ltd'],
    industries: ['Public services'],
    locations: ['London'],
  }, { now: () => '2026-07-31T09:00:00.000Z' });
  const reconciled = reconcileEmployerDiscoveries(reviewed, [{
    canonicalName: 'Acme Ltd',
    origin: {
      kind: 'advert-discovered',
      recordedAt: '2026-07-31T10:00:00.000Z',
      reference: 'vacancy-acme-ltd',
    },
  }], { now: () => '2026-07-31T10:00:00.000Z' });

  assert.equal(reconciled.employers.length, 1);
  assert.equal(reconciled.employers[0].id, initial.employers[0].id);
  assert.equal(reconciled.employers[0].canonicalName, 'Acme');
  assert.deepEqual(reconciled.employers[0].aliases, ['Acme Ltd']);
  assert.deepEqual(reconciled.employers[0].origins.map(({ kind }) => kind), [
    'advert-discovered', 'manual',
  ]);
  assert.equal(selectEmployersForMonitoring(reconciled, {
    limit: 12, now: () => '2026-08-01T12:00:00.000Z',
  }).length, 1);
});

test('alias and metadata removal is versioned, durable and explicitly undoable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-employer-aliases-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const initial = createEmployerRegistry([discovery('Acme', {
    aliases: ['Acme Ltd'],
    industries: ['Technology'],
    locations: ['Manchester'],
  })], { now: () => AT });
  const removed = updateEmployerRegistryEntry(initial, {
    id: initial.employers[0].id,
    aliases: [],
    industries: [],
    locations: [],
  }, { now: () => '2026-07-31T09:00:00.000Z' });
  const review = removed.employers[0].reviewHistory[0];

  assert.deepEqual(review.before.aliases, ['Acme Ltd']);
  assert.deepEqual(review.after.aliases, []);
  assert.equal(removed.generation, initial.generation + 1);

  const restored = undoEmployerRegistryReview(removed, {
    employerId: initial.employers[0].id,
    reviewId: review.id,
  }, { now: () => '2026-07-31T10:00:00.000Z' });
  assert.deepEqual(restored.employers[0].aliases, ['Acme Ltd']);
  assert.deepEqual(restored.employers[0].industries, ['Technology']);
  assert.deepEqual(restored.employers[0].locations, ['Manchester']);
  assert.equal(restored.employers[0].reviewHistory[1].undoOf, review.id);
  assert.throws(() => undoEmployerRegistryReview(restored, {
    employerId: initial.employers[0].id,
    reviewId: review.id,
  }), /unavailable/);

  writeEmployerRegistry(root, restored);
  assert.deepEqual(loadEmployerRegistry(root).employers[0].aliases, ['Acme Ltd']);
  assert.deepEqual(loadEmployerRegistry(root).employers[0].reviewHistory, restored.employers[0].reviewHistory);
});

test('an alias cannot ambiguously identify two employers', () => {
  const registry = createEmployerRegistry([
    discovery('Acme'),
    discovery('Other Company'),
  ], { now: () => AT });
  const other = registry.employers.find(({ canonicalName }) => canonicalName === 'Other Company');
  assert.throws(() => updateEmployerRegistryEntry(registry, {
    id: other.id,
    aliases: ['Acme'],
  }), /ambiguous/);
});
