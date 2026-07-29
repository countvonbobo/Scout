import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RELEASE_FILES } from './build-release.mjs';
import { auditRelease, loadMarkers, main } from './release-audit.mjs';

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-audit-'));
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RANKED_DISCOVERY_SOURCES = [
  'ui/lib/searchProfile.mjs', 'ui/lib/vacancyObservation.mjs', 'ui/lib/vacancyCanonical.mjs',
  'ui/lib/vacancyFilter.mjs', 'ui/lib/vacancyRank.mjs', 'ui/lib/vacancySelect.mjs',
  'ui/lib/discoveryFunnel.mjs', 'ui/lib/scanPipeline.mjs',
];
const FIXTURE_TITLES = [
  'Software Developer', 'Hospital Administrator', 'Hospitality Worker',
  'Commercial Solicitor', 'Mechanical Engineering Graduate', 'Retail Manager',
];

test('passes clean tracked files and build output', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'README.md'), '# Generic project\n');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'app.txt'), 'packaged application\n');
  const result = auditRelease({ root, trackedFiles: ['README.md'], buildDirs: ['dist'], markers: ['Casey Exampleperson'] });
  assert.equal(result.ok, true);
  assert.equal(result.filesScanned, 2);
});

test('reports marker and secret rules without retaining their values', () => {
  const root = fixture();
  const marker = 'Casey Exampleperson';
  const token = ['ghp_', 'A'.repeat(36)].join('');
  fs.writeFileSync(path.join(root, 'profile.txt'), `${marker}\n${token}\n`);
  const result = auditRelease({ root, trackedFiles: ['profile.txt'], buildDirs: [], markers: [marker] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ line, rule }) => ({ line, rule })), [
    { line: 1, rule: 'personal-marker-1' },
    { line: 2, rule: 'github-token' },
  ]);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('rejects private runtime artifact paths from a release tree', () => {
  const root = fixture();
  const files = [
    'data/scan-runs.jsonl',
    '.scout/runs/run-synthetic/journal.jsonl',
    '.scout/provider-health/claude.json',
    'profile/context.md',
    'cv/master-cv.md',
    'applications/synthetic-role/cv.typ',
    'reports/2026-07-29.md',
    'chats/synthetic.json',
  ];
  for (const relative of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  }
  const result = auditRelease({ root, trackedFiles: files, buildDirs: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(
    [...new Set(result.findings.map(({ rule }) => rule))],
    ['private-runtime-artifact'],
  );
  assert.equal(result.findings.length, files.length);
});

test('rejects raw run, auth, prompt, CV, advert, transcript and tracking payloads', () => {
  const root = fixture();
  const cases = [
    ['raw-run.json', { rawRunState: { phase: 'synthetic-private-phase' } }, 'raw-run-state'],
    ['raw-auth.json', { rawAuthOutput: 'synthetic-auth-output' }, 'raw-auth-output'],
    ['auth-code.json', { authorizationCode: 'SYNTHETIC-CODE-1234' }, 'auth-code'],
    ['prompt.json', { prompt: 'A synthetic private prompt body that must not ship.' }, 'full-prompt'],
    ['cv.json', { cvText: 'Synthetic private CV body that must not ship.' }, 'cv-body'],
    ['advert.json', { advertBody: 'Synthetic full advert body that must not ship.' }, 'advert-body'],
    ['transcript.json', { providerTranscript: 'Synthetic provider transcript.' }, 'provider-transcript'],
    ['tracking.json', { trackingValue: 'utm_source=synthetic-private' }, 'tracking-value'],
    ['private-path.json', { path: '/Users/synthetic-private/Scout Workspace' }, 'private-path'],
  ];
  for (const [relative, value] of cases) {
    fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value)}\n`);
  }
  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map(({ file, rule }) => [file, rule]),
    cases.map(([file, _value, rule]) => [file, rule])
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  );
  assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
});

test('ignores documented placeholder credential assignments', () => {
  const root = fixture();
  const example = [`${'API'}_KEY=replace-me`, `${'PASS'}WORD=<your-password>`].join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'example.env'), example);
  const result = auditRelease({ root, trackedFiles: ['example.env'], buildDirs: [] });
  assert.equal(result.ok, true);
});

test('ignores credential variable expressions and binary files', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'source.mjs'), "const apiKey = String(env.ADZUNA_API_KEY || '').trim();\nconst token = crypto.randomUUID();\n");
  fs.writeFileSync(path.join(root, 'runtime.exe'), Buffer.from([77, 90, 0, 1, 2, 3]));
  const result = auditRelease({ root, trackedFiles: ['source.mjs', 'runtime.exe'], buildDirs: [] });
  assert.equal(result.ok, true);
  assert.equal(result.filesScanned, 1);
});

test('loads sorted unique markers from file and environment', () => {
  const root = fixture();
  const file = path.join(root, 'markers.txt');
  fs.writeFileSync(file, '# private CI file\nSecond marker\nFirst marker\nSecond marker\n');
  assert.deepEqual(loadMarkers({ markerFile: file, envMarkers: 'Third marker\nFirst marker' }), [
    'First marker', 'Second marker', 'Third marker',
  ]);
});

test('stage mode scans an exported tree without requiring Git metadata', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'README.md'), '# Scout\n');
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (value) => { writes.push(String(value)); return true; };
  try {
    const result = main(['--root', root, '--stage'], {});
    assert.equal(result.ok, true);
    assert.equal(result.filesScanned, 1);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(writes.join(''), /Release audit passed/);
});

test('ranked discovery production sources stay neutral and release bundles omit raw observation caches', () => {
  const productionText = RANKED_DISCOVERY_SOURCES
    .map((relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');

  for (const title of FIXTURE_TITLES) assert.doesNotMatch(productionText, new RegExp(title, 'i'));
  assert.doesNotMatch(productionText, /oliver/i);
  assert.equal(RELEASE_FILES.some(({ source }) => source === 'profile' || source.startsWith('profile/')), false);
  assert.equal(RELEASE_FILES.some(({ source }) => source === 'data' || source.startsWith('data/')), false);
});

test('default audit evaluates releasable sources without treating test lock tokens as credentials', () => {
  const result = auditRelease({ root: ROOT, buildDirs: [] });

  assert.equal(result.ok, true);
  assert.equal(result.findings.some(({ file }) => file.endsWith('.test.mjs')), false);
});
