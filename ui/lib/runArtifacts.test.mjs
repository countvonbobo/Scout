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

const roots = [];
const lease = { leaseId: 'lease-1', generation: 1 };

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-run-artifacts-'));
  roots.push(root);
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
  const ref = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, value);

  assert.deepEqual(ref, { id: 'collect-v1', schemaVersion: 1, digest: sha256(value) });
  assert.deepEqual(readRunArtifact(ref), value);

  assert.throws(() => readRunArtifact({ ...run, ...ref, digest: '0'.repeat(64) }), ArtifactIntegrityError);
});

test('rejects artifacts whose schema is not supported before writing them', () => {
  const run = openRunJournal(temp(), 'run-1');

  assert.throws(
    () => commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 2 }, { schemaVersion: 2, stableIds: [] }),
    /unsupported artifact schema/i,
  );
  assert.equal(fs.existsSync(path.join(run.directory, 'artifacts')), false);
});

test('rebuilds a missing manifest entirely from journalled completion, compatibility, outcome, and receipt events', () => {
  const run = openRunJournal(temp(), 'run-1');
  const artifact = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: ['vacancy-1'] });
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
  const result = validateManifestAgreement(run);

  assert.equal(result.rebuilt, true);
  assert.deepEqual(result.manifest, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run.directory, 'manifest.json'), 'utf8')), expected);
});

test('rejects a manifest that claims an artifact not referenced by the journal', () => {
  const run = openRunJournal(temp(), 'run-1');
  const artifact = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: [] });
  completed(run, artifact);
  const manifest = projectRunManifest(run.events);
  manifest.artifacts.push({ id: 'not-journalled', schemaVersion: 1, digest: 'b'.repeat(64) });
  fs.writeFileSync(path.join(run.directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');

  assert.throws(() => validateManifestAgreement(run), ManifestAgreementError);
});

test('rejects raw or invented manifest content before it can be stored', () => {
  const run = openRunJournal(temp(), 'run-1');

  for (const manifest of [
    { rawCv: 'private content' },
    { schemaVersion: 1, runId: 'run-1', artifacts: [{ id: 'invented', schemaVersion: 1, digest: 'a'.repeat(64) }] },
  ]) {
    assert.throws(() => replaceRunManifest(run, manifest), ManifestAgreementError);
  }
  assert.equal(fs.existsSync(path.join(run.directory, 'manifest.json')), false);
});

test('keeps a journalled artifact readable when a later commit uses its ID with a different digest', () => {
  const run = openRunJournal(temp(), 'run-1');
  const firstValue = { schemaVersion: 1, stableIds: ['vacancy-1'] };
  const first = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, firstValue);
  completed(run, first);
  const second = commitRunArtifact(run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: ['vacancy-2'] });

  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(readRunArtifact(first), firstValue);
  assert.equal(validateManifestAgreement(run).rebuilt, true);
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
  assert.equal(validateManifestAgreement(run).rebuilt, true);
});
