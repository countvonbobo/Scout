import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { appendRunEvent, openRunJournal } from './runJournal.mjs';
import {
  ArtifactIntegrityError, ManifestAgreementError, commitRunArtifact, projectRunManifest,
  readRunArtifact, replaceRunManifest, validateManifestAgreement,
} from './runArtifacts.mjs';
import { acquireScanLease, currentLeaseOwner } from './scanLease.mjs';

const roots = [];
let lease;

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-run-artifacts-'));
  roots.push(root);
  lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'run-1' });
  return root;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function completed(run, artifact) {
  return appendRunEvent(run, {
    type: 'stage.completed',
    stageId: 'collect',
    idempotencyKey: 'collect-v1',
    payload: {
      schemaVersion: 1,
      reference: { kind: 'source', id: 'adzuna' },
      count: 2,
      version: { kind: 'pipeline', value: 'pipeline-v1' },
      artifact,
    },
  }, lease);
}

test('commits a bounded versioned artifact and reads it only when its digest matches', () => {
  const run = openRunJournal(temp(), 'run-1');
  const value = { schemaVersion: 1, stableIds: ['vacancy-1', 'vacancy-2'] };
  const ref = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, value, lease);

  assert.deepEqual(ref, { id: 'collect-v1', schemaVersion: 1, digest: sha256(value) });
  assert.deepEqual(readRunArtifact(ref), value);

  assert.throws(() => readRunArtifact({ ...run, ...ref, digest: '0'.repeat(64) }), ArtifactIntegrityError);
});

test('commits a bounded stage-data artifact without accepting provider or credential transcripts', () => {
  const run = openRunJournal(temp(), 'run-1');
  const value = {
    schemaVersion: 2,
    stageId: 'select',
    stableIds: ['vacancy-1'],
    data: { selected: [{ vacancyId: 'vacancy-1', title: 'Synthetic role' }] },
  };
  const ref = commitRunArtifact(run, { id: 'select-v1', schemaVersion: 2 }, value, lease);

  assert.deepEqual(readRunArtifact(ref), value);
  for (const privateData of [
    { prompt: 'private provider request' },
    { rawResponse: 'private provider response' },
    { credentials: { [['to', 'ken'].join('')]: ['private', 'credential'].join(' ') } },
    { profileEvidence: 'private CV evidence' },
    { advertBody: 'full private advert content' },
    { [['access', 'Token'].join('')]: ['private', 'provider', 'token'].join(' ') },
    { [['author', 'ization'].join('')]: ['private', 'provider', 'authorization'].join(' ') },
    { masterCv: 'private CV content' },
    { description: 'full private advert content' },
    { requirements: 'full private requirements content' },
    { rawHtml: '<html>private advert</html>' },
    { body: 'private response body' },
    { cookies: ['private session'] },
    { headers: { value: 'private request headers' } },
    { payload: 'private provider payload' },
    { response: 'private provider response' },
  ]) {
    assert.throws(
      () => commitRunArtifact(run, { id: `select-private-${Object.keys(privateData)[0]}`, schemaVersion: 2 }, {
        schemaVersion: 2, stageId: 'select', stableIds: [], data: privateData,
      }, lease),
      /private pipeline artifact property/i,
    );
  }
});

test('assessment artifacts enforce their kind-specific privacy envelope', () => {
  const run = openRunJournal(temp(), 'run-1');
  const request = {
    schemaVersion: 1,
    batchId: 'batch-1',
    runId: 'run-1',
    contextDigests: {
      scoringConfigDigest: '1'.repeat(64),
      profileDigest: '2'.repeat(64),
      calibrationDigest: '3'.repeat(64),
      masterCvDigest: '4'.repeat(64),
    },
    jobReferences: [{ jobId: 'candidate-001', inputDigest: 'a'.repeat(64) }],
    parameters: { maxJobs: 10, maxInputTokens: 75_000, timeoutMs: 60_000, contextBudgetCharacters: 280_000 },
    provenance: {
      profileVersion: 'profile-v1',
      promptVersion: 'prompt-v1',
      assessmentSchemaVersion: 1,
      pipelineVersion: 'pipeline-v1',
      provider: 'codex',
      model: 'provider-default',
    },
  };
  const value = {
    schemaVersion: 3,
    type: 'request',
    stableIds: ['candidate-001'],
    data: { request },
  };
  assert.doesNotThrow(() => commitRunArtifact(run, { id: 'assessment-request', schemaVersion: 3 }, value, lease));
  assert.throws(
    () => commitRunArtifact(run, { id: 'assessment-arbitrary', schemaVersion: 3 }, {
      schemaVersion: 3, type: 'request', stableIds: [], data: { summary: 'unreviewed persisted content' },
    }, lease),
    /assessment request artifact shape/i,
  );
  assert.throws(
    () => commitRunArtifact(run, { id: 'assessment-private', schemaVersion: 3 }, {
      ...value,
      data: { request: { ...request, prompt: 'full private prompt' } },
    }, lease),
    /private assessment artifact property/i,
  );
});

test('assessment result artifacts reject URL-bearing and secret-shaped evidence before writing', () => {
  const run = openRunJournal(temp(), 'run-1');
  const unsafeValues = [
    `https://example.test/evidence?${['access', 'token'].join('_')}=PRIVATE_QUERY_SECRET`,
    'https://example.test/evidence#PRIVATE_FRAGMENT_SECRET',
    'https://PRIVATE_USER:PRIVATE_PASSWORD@example.test/evidence',
    'Bearer PRIVATE_BEARER_SECRET_123456789',
    ['sk', 'PRIVATE_OPENAI_SECRET_1234567890'].join('-'),
  ];
  const baseAssessment = {
    candidateId: 'candidate-001',
    categoryId: null,
    summary: 'Safe bounded summary.',
    hardExclusionMatches: [],
    mandatoryRequirements: [],
    dimensions: [{ name: 'fit', score: 80, maximum: 100, evidence: 'Safe bounded evidence.' }],
    recommendation: 'keep',
  };

  for (const [index, unsafe] of unsafeValues.entries()) {
    assert.throws(
      () => commitRunArtifact(run, {
        id: `assessment-unsafe-${index}`,
        schemaVersion: 3,
      }, {
        schemaVersion: 3,
        type: 'result',
        stableIds: ['vacancy-001'],
        data: {
          batchId: 'batch-1',
          jobId: 'vacancy-001',
          inputDigest: 'a'.repeat(64),
          fencingGeneration: 1,
          assessment: {
            ...baseAssessment,
            dimensions: [{ ...baseAssessment.dimensions[0], evidence: unsafe }],
          },
          provenance: {
            provider: 'codex',
            model: 'provider-default',
            promptVersion: 'prompt-v1',
            assessmentSchemaVersion: 1,
          },
        },
      }, lease),
      /assessment artifact (?:URLs?|credentials) are not allowed/i,
    );
  }

  const durableText = fs.existsSync(path.join(run.directory, 'artifacts'))
    ? fs.readdirSync(path.join(run.directory, 'artifacts'), { recursive: true })
      .map((entry) => path.join(run.directory, 'artifacts', entry))
      .filter((file) => fs.statSync(file).isFile())
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n')
    : '';
  for (const unsafe of unsafeValues) assert.equal(durableText.includes(unsafe), false);
});

test('the larger pipeline bound does not loosen the legacy artifact schema', () => {
  const run = openRunJournal(temp(), 'run-1');
  const legacyIds = Array.from({ length: 128 }, (_, index) => (
    `vacancy-${String(index).padStart(3, '0')}-${'x'.repeat(116)}`
  ));

  assert.throws(
    () => commitRunArtifact(run, { id: 'legacy-oversized', schemaVersion: 1 }, {
      schemaVersion: 1,
      stableIds: legacyIds,
    }, lease),
    /16 KiB limit/i,
  );
  const pipelineValue = {
    schemaVersion: 2,
    stageId: 'collect',
    stableIds: ['vacancy-1'],
    data: { boundedData: 'x'.repeat(20 * 1024) },
  };
  const ref = commitRunArtifact(run, { id: 'pipeline-larger', schemaVersion: 2 }, pipelineValue, lease);
  assert.deepEqual(readRunArtifact(ref), pipelineValue);
});

test('rejects artifacts whose schema is not supported before writing them', () => {
  const run = openRunJournal(temp(), 'run-1');

  assert.throws(
    () => commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 4 }, { schemaVersion: 4, stableIds: [] }, lease),
    /unsupported artifact schema/i,
  );
  assert.equal(fs.existsSync(path.join(run.directory, 'artifacts')), false);
});

test('rebuilds a missing manifest entirely from journalled completion, compatibility, outcome, and receipt events', () => {
  const run = openRunJournal(temp(), 'run-1');
  const artifact = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: ['vacancy-1'] }, lease);
  completed(run, artifact);
  appendRunEvent(run, {
    type: 'run.completed', stageId: 'finalise', idempotencyKey: 'run-complete-v1',
    payload: { schemaVersion: 1, outcome: 'complete', compatibility: { kind: 'profile', value: 'profile-v1' } },
  }, lease);
  appendRunEvent(run, {
    type: 'mutation.receipted', stageId: 'tracker', idempotencyKey: 'tracker-v1',
    payload: { schemaVersion: 1, reference: { kind: 'mutation', id: 'tracker-v1' }, digest: 'a'.repeat(64) },
  }, lease);

  const expected = projectRunManifest(run.events);
  const result = validateManifestAgreement(run, lease);

  assert.equal(result.rebuilt, true);
  assert.deepEqual(result.manifest, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.directory, 'manifest.json'), 'utf8')), expected);
});

test('manifest projection rejects duplicate receipts for one mutation identity', () => {
  const run = openRunJournal(temp(), 'run-1');
  for (const key of ['receipt-one', 'receipt-two']) {
    appendRunEvent(run, {
      type: 'mutation.receipted',
      stageId: 'finalise',
      idempotencyKey: key,
      payload: {
        schemaVersion: 1,
        reference: { kind: 'mutation', id: 'mutation-one' },
        digest: 'a'.repeat(64),
      },
    }, lease);
  }
  assert.throws(() => projectRunManifest(run.events), /duplicate mutation receipt/i);
});

test('rebuilds a contradictory manifest from the valid journal without trusting invented work', () => {
  const run = openRunJournal(temp(), 'run-1');
  const artifact = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: [] }, lease);
  completed(run, artifact);
  const manifest = projectRunManifest(run.events);
  manifest.artifacts.push({ id: 'not-journalled', schemaVersion: 1, digest: 'b'.repeat(64) });
  fs.writeFileSync(path.join(run.directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');

  const rebuilt = validateManifestAgreement(run, lease);
  assert.equal(rebuilt.rebuilt, true);
  assert.deepEqual(rebuilt.manifest, projectRunManifest(run.events));
  assert.ok(!rebuilt.manifest.artifacts.some((item) => item.id === 'not-journalled'));
});

test('rebuilds an unreadable derived manifest after journal validation', () => {
  const run = openRunJournal(temp(), 'run-1');
  const artifact = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: [] }, lease);
  completed(run, artifact);
  fs.writeFileSync(path.join(run.directory, 'manifest.json'), '{"schemaVersion":', 'utf8');

  const rebuilt = validateManifestAgreement(run, lease);

  assert.equal(rebuilt.rebuilt, true);
  assert.deepEqual(rebuilt.manifest, projectRunManifest(run.events));
});

test('rejects raw or invented manifest content before it can be stored', () => {
  const run = openRunJournal(temp(), 'run-1');

  for (const manifest of [
    { rawCv: 'private content' },
    { schemaVersion: 1, runId: 'run-1', artifacts: [{ id: 'invented', schemaVersion: 1, digest: 'a'.repeat(64) }] },
  ]) {
    assert.throws(() => replaceRunManifest(run, manifest, lease), ManifestAgreementError);
  }
  assert.equal(fs.existsSync(path.join(run.directory, 'manifest.json')), false);
});

test('keeps a journalled artifact readable when a later commit uses its ID with a different digest', () => {
  const run = openRunJournal(temp(), 'run-1');
  const firstValue = { schemaVersion: 1, stableIds: ['vacancy-1'] };
  const first = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, firstValue, lease);
  completed(run, first);
  const second = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: ['vacancy-2'] }, lease);

  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(readRunArtifact(first), firstValue);
  assert.equal(validateManifestAgreement(run, lease).rebuilt, true);
});

test('rebuilds from a fully verified artifact written in the original ID-only layout', () => {
  const run = openRunJournal(temp(), 'run-1');
  const value = { schemaVersion: 1, stableIds: ['vacancy-1'] };
  const ref = { id: 'collect-v1', schemaVersion: 1, digest: sha256(value) };
  const legacyFile = path.join(run.directory, 'artifacts', `${createHash('sha256').update(ref.id).digest('hex')}.json`);
  const legacyEnvelope = { storageSchemaVersion: 1, id: ref.id, schemaVersion: 1, digest: ref.digest, value };
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, `${canonicalJson(legacyEnvelope)}\n`, 'utf8');
  completed(run, ref);

  assert.deepEqual(readRunArtifact({ ...run, ...ref }), value);
  assert.equal(validateManifestAgreement(run, lease).rebuilt, true);
});

test('rebuilds the prior manifest schema after the additive recovery projection upgrade', () => {
  const run = openRunJournal(temp(), 'run-1');
  const artifact = commitRunArtifact(
    run,
    { id: 'collect-v1', schemaVersion: 1 },
    { schemaVersion: 1, stableIds: ['vacancy-1'] },
    lease,
  );
  completed(run, artifact);
  const current = projectRunManifest(run.events);
  const {
    recoveryDecisions: _recoveryDecisions,
    providerSubstitutions: _providerSubstitutions,
    ...prior
  } = current;
  prior.schemaVersion = 1;
  fs.writeFileSync(path.join(run.directory, 'manifest.json'), `${canonicalJson(prior)}\n`, 'utf8');

  const result = validateManifestAgreement(run, lease);

  assert.equal(result.rebuilt, true);
  assert.equal(result.manifest.schemaVersion, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.directory, 'manifest.json'), 'utf8')), result.manifest);
});
