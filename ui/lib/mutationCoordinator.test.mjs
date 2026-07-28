import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  MutationConflictError,
  applyPreparedMutation,
  loadPreparedMutation,
  prepareMutation,
  reconcileMutation,
  withMutationCoordinator,
} from './mutationCoordinator.mjs';
import { coordinateScanArtifacts } from './scanPipeline.mjs';
import {
  acquireScanLease, currentLeaseOwner, releaseScanLease,
} from './scanLease.mjs';
import { appendRunEvent, openRunJournal, replayRunJournal } from './runJournal.mjs';

const roots = [];

function canonicalJson(value) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-coordinator-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{\n  "updated": "2026-07-28",\n  "opportunities": []\n}\n');
  fs.writeFileSync(path.join(root, 'reports', '2026-07-28.md'), '# Scout report\n\n## Headline\n\nBefore.\n');
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'run-task-8' });
  const handle = openRunJournal(root, 'run-task-8');
  return { root, lease, handle };
}

function mutationInput() {
  return {
    target: {
      id: 'scan-tracker-report',
      schemaVersion: 1,
      files: [
        { kind: 'tracker', key: 'tracker' },
        { kind: 'report', key: 'report:2026-07-28' },
      ],
    },
    content: {
      tracker: '{\n  "updated": "2026-07-28",\n  "opportunities": [{"id":"valid-sibling"}]\n}\n',
      'report:2026-07-28': '# Scout report\n\n## Headline\n\nOne valid sibling; one bounded assessment failure.\n',
    },
  };
}

test('a matching post-replacement identity reconciles without replay and appends one receipt', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput();
  const plan = prepareMutation({ handle, lease }, target, content);
  let replacements = 0;

  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      afterReplacement() {
        replacements += 1;
        if (replacements === 2) throw new Error('synthetic crash before receipt');
      },
    }),
    /synthetic crash before receipt/,
  );
  assert.equal(reconcileMutation(plan).status, 'applied-unreceipted');

  const receipt = applyPreparedMutation(plan, lease, {
    beforeReplacement() {
      assert.fail('matching content must be acknowledged without replay');
    },
  });
  assert.equal(receipt.id, plan.mutationId);
  assert.equal(reconcileMutation(plan).status, 'receipted');
  assert.deepEqual(
    replayRunJournal(handle.file).map((event) => event.type),
    ['mutation.prepared', 'mutation.receipted'],
  );
});

test('crashes before replacement and after one replacement resume only pending targets', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput();
  const plan = prepareMutation({ handle, lease }, target, content);

  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      beforeReplacement() {
        throw new Error('synthetic crash before replacement');
      },
    }),
    /synthetic crash before replacement/,
  );
  assert.equal(reconcileMutation(plan).status, 'prepared');

  let replacements = 0;
  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      afterReplacement() {
        replacements += 1;
        throw new Error('synthetic crash after first replacement');
      },
    }),
    /synthetic crash after first replacement/,
  );
  assert.equal(replacements, 1);
  assert.equal(reconcileMutation(plan).status, 'partially-applied');

  const replaced = [];
  applyPreparedMutation(plan, lease, {
    beforeReplacement(file) {
      replaced.push(file.key);
    },
  });
  assert.deepEqual(replaced, ['report:2026-07-28']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8')).opportunities[0].id, 'valid-sibling');
});

test('conflicting and unverifiable target states fail closed', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput();
  const plan = prepareMutation({ handle, lease }, target, content);
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"opportunities":[{"id":"operator-edit"}]}\n');
  assert.throws(() => reconcileMutation(plan), MutationConflictError);
  assert.throws(() => applyPreparedMutation(plan, lease), MutationConflictError);

  const report = path.join(root, 'reports', '2026-07-28.md');
  fs.writeFileSync(report, `${fs.readFileSync(report, 'utf8')}\n<!-- scout-mutation:not-json -->\n`);
  assert.throws(() => reconcileMutation(plan), MutationConflictError);
});

test('a stale fencing generation cannot mutate or append a receipt', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput();
  const plan = prepareMutation({ handle, lease }, target, content);
  releaseScanLease(lease);
  const successor = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'successor-run' });

  assert.throws(() => applyPreparedMutation(plan, lease), /lease/i);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.receipted').length, 0);
  releaseScanLease(successor);
});

test('the shared OS-level coordinator excludes another mutation boundary', () => {
  const { root, lease } = fixture();
  assert.throws(
    () => withMutationCoordinator(root, lease, () => (
      withMutationCoordinator(root, lease, () => assert.fail('nested mutation must not run'))
    )),
    /another workspace mutation is in progress/,
  );
  assert.equal(fs.existsSync(path.join(root, '.scout', 'mutation.guard')), false);
});

test('the shared coordinator remains held until the durable receipt is appended', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput();
  const plan = prepareMutation({ handle, lease }, target, content);

  applyPreparedMutation(plan, lease, {
    beforeReceipt() {
      assert.throws(
        () => withMutationCoordinator(root, lease, () => assert.fail('receipt gap admitted another mutation')),
        /another workspace mutation is in progress/,
      );
    },
  });
  assert.equal(reconcileMutation(plan).status, 'receipted');
});

test('the canonical run, target revision and intended content produce one stable prepared plan', () => {
  const { lease, handle } = fixture();
  const { target, content } = mutationInput();
  const first = prepareMutation({ handle, lease }, target, content);
  const second = prepareMutation({ handle, lease }, target, structuredClone(content));

  assert.equal(second.mutationId, first.mutationId);
  assert.equal(second.key, first.key);
  assert.equal(second.intendedDigest, first.intendedDigest);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.prepared').length, 1);
});

test('the journal rejects a self-consistent prepared artifact forged after preparation', () => {
  const { lease, handle } = fixture();
  const { target, content } = mutationInput();
  const plan = prepareMutation({ handle, lease }, target, content);
  const artifactFile = path.join(handle.directory, 'mutations', `${plan.mutationId}.json`);
  const envelope = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  envelope.value.target.id = 'forged-target';
  envelope.digest = digest(envelope.value);
  fs.writeFileSync(artifactFile, `${canonicalJson(envelope)}\n`);

  assert.throws(
    () => loadPreparedMutation(handle, plan.mutationId),
    /journal.*digest|prepared.*journal/i,
  );
});

test('coordinator fails closed when one mutation identity has duplicate receipts', () => {
  const { lease, handle } = fixture();
  const { target, content } = mutationInput();
  const plan = prepareMutation({ handle, lease }, target, content);
  applyPreparedMutation(plan, lease);
  appendRunEvent(handle, {
    type: 'mutation.receipted',
    stageId: 'finalise',
    idempotencyKey: 'forged-duplicate-receipt',
    payload: {
      schemaVersion: 1,
      reference: { kind: 'mutation', id: plan.mutationId },
      digest: plan.receiptDigest,
    },
  }, lease);

  assert.throws(() => reconcileMutation(plan), /duplicate mutation receipt/i);
});

test('prepared mutation artifacts reject credentials and forbidden private payload fields', () => {
  const { lease, handle } = fixture();
  const { target, content } = mutationInput();
  const unsafe = structuredClone(content);
  unsafe.tracker = JSON.stringify({
    opportunities: [],
    rawProviderResponse: 'Bearer secret-token-value',
  });

  assert.throws(
    () => prepareMutation({ handle, lease }, target, unsafe),
    /private mutation content|credential/i,
  );
  assert.equal(replayRunJournal(handle.file).length, 0);
  assert.equal(fs.existsSync(path.join(handle.directory, 'mutations')), false);
});

test('prepared mutation artifacts reject paths, private source bodies and non-canonical URLs', () => {
  const unsafeValues = [
    'C:\\Users\\private\\candidate-cv.md',
    '/home/private/candidate-cv.md',
    '/srv/scout/private-candidate-cv.md',
    '\\private\\candidate-cv.md',
    'full private prompt for assessing this candidate',
    'curriculum vitae: private employment history',
    'full advert text copied from the provider',
    'raw provider output: private source response',
    'https://user:password@example.test/job',
    'https://example.test/job#candidate-private-fragment',
    'https://example.test/job?utm_source=private',
  ];

  for (const unsafeValue of unsafeValues) {
    const { lease, handle } = fixture();
    const { target, content } = mutationInput();
    const unsafe = structuredClone(content);
    unsafe.tracker = JSON.stringify({
      updated: '2026-07-28',
      opportunities: [{ id: 'candidate-001', notes: unsafeValue }],
    });
    assert.throws(
      () => prepareMutation({ handle, lease }, target, unsafe),
      /private mutation content|absolute path|canonical url|tracking|credential/i,
      `structured mutation payload admitted: ${unsafeValue}`,
    );
    assert.equal(fs.existsSync(path.join(handle.directory, 'mutations')), false);
  }
});

test('opaque report bodies reject paths, source bodies and non-canonical URLs', () => {
  const unsafeValues = [
    'C:\\Users\\private\\candidate-cv.md',
    '/home/private/candidate-cv.md',
    '/srv/scout/private-candidate-cv.md',
    '\\private\\candidate-cv.md',
    'Full private prompt for assessing this candidate.',
    'Curriculum vitae: private employment history.',
    'Full advert text copied from the provider.',
    'Raw provider response copied without projection.',
    'https://user:password@example.test/job',
    'https://example.test/job#candidate-private-fragment',
    'https://example.test/job?gclid=private',
  ];

  for (const unsafeValue of unsafeValues) {
    const { lease, handle } = fixture();
    const { target, content } = mutationInput();
    const unsafe = structuredClone(content);
    unsafe['report:2026-07-28'] = `# Scout report\n\n## Headline\n\n${unsafeValue}\n`;
    assert.throws(
      () => prepareMutation({ handle, lease }, target, unsafe),
      /private mutation content|absolute path|canonical url|tracking|credential/i,
      `opaque report admitted: ${unsafeValue}`,
    );
    assert.equal(fs.existsSync(path.join(handle.directory, 'mutations')), false);
  }
});

test('prepared artifacts use resolver-backed opaque keys and one canonical content copy', () => {
  const { lease, handle } = fixture();
  const plan = prepareMutation({ handle, lease }, {
    id: 'scan-tracker-report',
    schemaVersion: 1,
    files: [
      { kind: 'tracker', key: 'tracker' },
      { kind: 'report', key: 'report:2026-07-28' },
    ],
  }, {
    tracker: '{\n  "updated": "2026-07-28",\n  "opportunities": []\n}\n',
    'report:2026-07-28': '# Scout report\n\n## Headline\n\nSafe bounded summary.\n',
  });
  const artifact = fs.readFileSync(
    path.join(handle.directory, 'mutations', `${plan.mutationId}.json`),
    'utf8',
  );

  assert.doesNotMatch(artifact, /data[\\/]opportunities|reports[\\/]2026|intendedContent|preparedContent|"path"/);
  assert.equal((artifact.match(/"content":/g) || []).length, 2);
  assert.deepEqual(plan.files.map((file) => file.key), ['tracker', 'report:2026-07-28']);
});

test('resolver rejects a tracker file reached through an escaping junction', { skip: process.platform !== 'win32' }, () => {
  const { root, lease, handle } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-outside-file-'));
  roots.push(outside);
  const outsideTracker = path.join(outside, 'opportunities.json');
  fs.writeFileSync(outsideTracker, '{"updated":"2026-07-28","opportunities":[]}\n');
  fs.rmSync(path.join(root, 'data'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'data'), 'junction');

  assert.throws(
    () => prepareMutation({ handle, lease }, {
      id: 'scan-tracker',
      schemaVersion: 1,
      files: [{ kind: 'tracker', key: 'tracker' }],
    }, {
      tracker: '{"updated":"2026-07-28","opportunities":[]}\n',
    }),
    /symlink|junction|outside its workspace/i,
  );
});

test('replacement rechecks containment after a directory is swapped for a junction', { skip: process.platform !== 'win32' }, () => {
  const { root, lease, handle } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-outside-junction-'));
  roots.push(outside);
  const outsideReport = path.join(outside, '2026-07-28.md');
  fs.writeFileSync(outsideReport, 'outside sentinel\n');
  const plan = prepareMutation({ handle, lease }, {
    id: 'scan-report',
    schemaVersion: 1,
    files: [{ kind: 'report', key: 'report:2026-07-28' }],
  }, {
    'report:2026-07-28': '# Scout report\n\n## Headline\n\nInside only.\n',
  });

  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      beforeReplacement() {
        fs.rmSync(path.join(root, 'reports'), { recursive: true });
        fs.symlinkSync(outside, path.join(root, 'reports'), 'junction');
      },
    }),
    /symlink|junction|outside its workspace/i,
  );
  assert.equal(fs.readFileSync(outsideReport, 'utf8'), 'outside sentinel\n');
  fs.rmSync(path.join(root, 'reports'));
  fs.mkdirSync(path.join(root, 'reports'));
  fs.writeFileSync(path.join(root, 'reports', '2026-07-28.md'), '# Scout report\n\n## Headline\n\nBefore.\n');
  assert.equal(reconcileMutation(plan).status, 'prepared');
});

test('partial assessment success produces one deterministic tracker/report plan without duplicate mutation', () => {
  const { root, lease, handle } = fixture();
  const candidates = [
    { candidateId: 'candidate-001', company: 'Valid Co', role: 'Engineer', url: 'https://example.test/valid', source: 'ats' },
    { candidateId: 'candidate-002', company: 'Failed Co', role: 'Engineer', url: 'https://example.test/failed', source: 'ats' },
  ];
  const input = {
    provider: 'codex',
    mode: 'primary',
    sources: { ats: { configured: true, status: 'healthy', count: 2 } },
    candidates,
    assessmentResult: {
      assessments: [{
        candidateId: 'candidate-001',
        categoryId: 'software',
        summary: 'Synthetic fit',
        hardExclusionMatches: [],
        mandatoryRequirements: [],
        dimensions: [{ name: 'Fit', score: 90, maximum: 100, evidence: 'Bounded evidence' }],
        recommendation: 'keep',
      }],
    },
    assessmentFailures: [{
      jobId: 'stable-job-002',
      code: 'assessment-exhausted',
      attempts: 3,
      validationFailures: ['missing-required-field'],
    }],
    policy: { actionScore: 70, checkScore: 55 },
    startedAt: '2026-07-28T09:00:00.000Z',
  };

  const first = coordinateScanArtifacts(root, input, { run: handle, lease });
  const second = coordinateScanArtifacts(root, input, { run: handle, lease });
  const tracker = JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8'));
  const scanRuns = fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8').trim().split(/\r?\n/);

  assert.equal(first.mutationReceipt.id, second.mutationReceipt.id);
  assert.equal(tracker.opportunities.length, 1);
  assert.equal(tracker.opportunities[0].company, 'Valid Co');
  assert.equal(scanRuns.length, 1);
  assert.deepEqual(JSON.parse(scanRuns[0]).assessment_failures, [{
    jobId: 'stable-job-002',
    code: 'assessment-exhausted',
    attempts: 3,
    validationFailures: ['missing-required-field'],
  }]);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.prepared').length, 1);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.receipted').length, 1);
});

test('a later scan strips mutation markers from historical run-log records', () => {
  const { root, lease, handle } = fixture();
  const input = {
    provider: 'codex',
    mode: 'primary',
    sources: { ats: { configured: true, status: 'healthy', count: 0 } },
    candidates: [],
    assessmentResult: { assessments: [] },
    policy: {},
    startedAt: '2026-07-28T09:00:00.000Z',
  };
  coordinateScanArtifacts(root, input, { run: handle, lease });
  releaseScanLease(lease);

  const successorLease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan',
    runId: 'run-task-8-successor',
  });
  const successorRun = openRunJournal(root, 'run-task-8-successor');
  coordinateScanArtifacts(root, { ...input, mode: 'second-pass' }, {
    run: successorRun,
    lease: successorLease,
  });

  const records = fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(Object.hasOwn(records[0], '_scoutMutation'), false);
  assert.equal(Object.hasOwn(records[1], '_scoutMutation'), true);
});
