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
import { openRunJournal, replayRunJournal } from './runJournal.mjs';

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
        { kind: 'tracker', path: 'data/opportunities.json' },
        { kind: 'report', path: 'reports/2026-07-28.md' },
      ],
    },
    content: {
      'data/opportunities.json': '{\n  "updated": "2026-07-28",\n  "opportunities": [{"id":"valid-sibling"}]\n}\n',
      'reports/2026-07-28.md': '# Scout report\n\n## Headline\n\nOne valid sibling; one bounded assessment failure.\n',
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
      replaced.push(file.path);
    },
  });
  assert.deepEqual(replaced, ['reports/2026-07-28.md']);
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

test('prepared mutation artifacts reject credentials and forbidden private payload fields', () => {
  const { lease, handle } = fixture();
  const { target, content } = mutationInput();
  const unsafe = structuredClone(content);
  unsafe['data/opportunities.json'] = JSON.stringify({
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
