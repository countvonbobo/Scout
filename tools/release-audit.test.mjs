import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const unixHome = (user, suffix = '') => ['', 'home', user, suffix].filter((part, index) => index === 0 || part).join('/');
const macHome = (user, suffix = '') => ['', 'Users', user, suffix].filter((part, index) => index === 0 || part).join('/');
const windowsHome = (user, suffix = '') => ['C:', 'Users', user, suffix].filter(Boolean).join('\\');
const uncHome = (share, user, suffix = '') =>
  ['', '', 'synthetic-fileserver', share, user, suffix].filter((part, index) => index < 2 || part).join('\\');

test('passes clean tracked files and build output', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'README.md'), '# Generic project\n');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'app.txt'), 'packaged application\n');
  const result = auditRelease({ root, trackedFiles: ['README.md'], buildDirs: ['dist'], markers: ['Casey Exampleperson'] });
  assert.equal(result.ok, true);
  assert.equal(result.filesScanned, 2);
});

test('refuses tracked and staged symlinks without following their targets', () => {
  if (process.platform === 'win32') return;
  const root = fixture();
  const privateFile = path.join(fixture(), 'private.txt');
  fs.writeFileSync(privateFile, 'Casey Exampleperson');
  fs.symlinkSync(privateFile, path.join(root, 'README.md'));
  assert.throws(
    () => auditRelease({ root, trackedFiles: ['README.md'], buildDirs: [], markers: ['Casey Exampleperson'] }),
    /refuses symbolic link/,
  );
});

test('refuses tracked files reached through a symlinked ancestor', () => {
  if (process.platform === 'win32') return;
  const root = fixture();
  const external = path.join(fixture(), 'docs');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'README.md'), 'Casey Exampleperson');
  fs.symlinkSync(external, path.join(root, 'docs'));
  assert.throws(
    () => auditRelease({
      root,
      trackedFiles: ['docs/README.md'],
      buildDirs: [],
      markers: ['Casey Exampleperson'],
    }),
    /refuses symbolic link/,
  );
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

test('reports UTF-8 and UTF-16 personal markers embedded in binary dependency artifacts', () => {
  const root = fixture();
  const marker = 'Casey Exampleperson';
  const files = [
    ['app/node_modules/synthetic-addon/build/addon.node', 'utf8'],
    ['app/node_modules/synthetic-addon/build/windows.node', 'utf16le'],
  ];
  for (const [relative, encoding] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0, 1, 2, 0]),
      Buffer.from(marker, encoding),
      Buffer.from([0, 255, 0]),
    ]));
  }
  const result = auditRelease({
    root,
    trackedFiles: files.map(([relative]) => relative),
    buildDirs: [],
    markers: [marker],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, files.map(([file]) => ({
    file, line: 1, rule: 'personal-marker-1',
  })));
  assert.equal(JSON.stringify(result).includes(marker), false);
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
    '.env',
    '.envrc',
    '.env.production',
    '.scout-backup/v1/header.json',
    'imports/source.txt',
    'logs/status.log',
    'workspace.json',
  ];
  const allowedTemplate = 'templates/workspace/workspace.json';
  const templateFile = path.join(root, allowedTemplate);
  fs.mkdirSync(path.dirname(templateFile), { recursive: true });
  fs.writeFileSync(templateFile, '{}\n');
  for (const relative of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  }
  const result = auditRelease({
    root,
    trackedFiles: [...files, allowedTemplate],
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    [...new Set(result.findings.map(({ rule }) => rule))],
    ['private-runtime-artifact'],
  );
  assert.equal(result.findings.length, files.length);
});

test('rejects raw run, auth, prompt, CV, advert, transcript and tracking payloads across ordinary serializations', () => {
  const root = fixture();
  const cases = [
    ['raw-run.json', { rawRunState: { phase: 'synthetic-private-phase' } }, 'raw-run-state'],
    ['raw-run-snake.json', { raw_run_state: { phase: 'synthetic-private-phase' } }, 'raw-run-state'],
    ['raw-events.jsonl', { events: [{ phase: 'synthetic-private-phase' }] }, 'raw-run-state'],
    ['nested-run.json', { run: { state: 'assessing', owner: { host: 'synthetic-private-host', pid: 1234 } } }, 'raw-run-state'],
    ['raw-auth.json', { rawAuthOutput: 'synthetic-auth-output' }, 'raw-auth-output'],
    ['raw-stdout.json', { stdout: 'synthetic-auth-output' }, 'raw-auth-output'],
    ['raw-payload.json', { rawPayload: 'synthetic-provider-output' }, 'raw-auth-output'],
    ['provider-output.json', { provider: 'codex', output: 'synthetic-auth-output' }, 'raw-auth-output'],
    ['nested-provider-payload.json', {
      provider: { payload: 'Synthetic provider output whose provenance is explicit.' },
    }, 'raw-auth-output'],
    ['nested-auth-output.json', {
      authentication: { output: 'Synthetic authentication output.' },
    }, 'raw-auth-output'],
    ['nested-run-payload.json', {
      run: { payload: 'Synthetic private run payload.' },
    }, 'raw-auth-output'],
    ['auth-code.json', { authorizationCode: 'SYNTHETIC-CODE-1234' }, 'auth-code'],
    ['auth-code-snake.json', { auth_code: 'SYNTHETIC-CODE-1234' }, 'auth-code'],
    ['provider-code.json', { provider: 'claude', code: 'SYNTHETIC-CODE-1234' }, 'auth-code'],
    ['session-user-code.json', { session: { state: 'awaiting-code', userCode: 'SYNTHETIC-CODE-1234' } }, 'auth-code'],
    ['device-code.json', { device: { code: 'SYNTHETIC-CODE-1234' } }, 'auth-code'],
    ['auth-code.txt', '"authCode":"SYNTHETIC-CODE-1234"', 'auth-code'],
    ['prompt.json', { prompt: 'A synthetic private prompt body that must not ship.' }, 'full-prompt'],
    ['full-prompt.json', { fullPrompt: 'A synthetic private prompt body that must not ship.' }, 'full-prompt'],
    ['prompt.txt', 'prompt: synthetic-private-prompt-body', 'full-prompt'],
    ['escaped-prompt.json', '{"pro\\u006dpt":"A synthetic private prompt body that must not ship."}', 'full-prompt'],
    ['cv.json', { cvText: 'Synthetic private CV body that must not ship.' }, 'cv-body'],
    ['master-cv.json', { masterCv: 'Synthetic private CV body that must not ship.' }, 'cv-body'],
    ['resume.json', { resume: 'Synthetic private CV body that must not ship.' }, 'cv-body'],
    ['advert.json', { advertBody: 'Synthetic full advert body that must not ship.' }, 'advert-body'],
    ['job-description.json', {
      company: 'Synthetic employer',
      title: 'Synthetic role',
      description: 'Synthetic private advert body '.repeat(12),
    }, 'advert-body'],
    ['wrapped-description.json', { job: { description: 'Synthetic short private advert.' } }, 'advert-body'],
    ['transcript.json', { providerTranscript: 'Synthetic provider transcript.' }, 'provider-transcript'],
    ['plain-transcript.json', { transcript: 'Synthetic provider transcript.' }, 'provider-transcript'],
    ['transcript.log', 'provider_transcript: synthetic-private-provider-output', 'provider-transcript'],
    ['tracking.json', { trackingValue: 'utm_source=synthetic-private' }, 'tracking-value'],
    ['tracking-key.json', { utm_source: 'synthetic-private' }, 'tracking-value'],
    ['private-path.json', { path: macHome('synthetic-private', 'Scout Workspace') }, 'private-path'],
    ['linux-private-path.json', { path: unixHome('synthetic-private', 'Scout Workspace') }, 'private-path'],
    ['linux-default-private-path.json', { path: unixHome('ubuntu', 'Documents/Scout Workspace') }, 'private-path'],
    ['linux-service-private-path.json', { path: unixHome('scout', 'private-state') }, 'private-path'],
    ['windows-private-path.json', { path: windowsHome('synthetic-private', 'Scout Workspace') }, 'private-path'],
  ];
  for (const [relative, value] of cases) {
    fs.writeFileSync(path.join(root, relative), `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
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

test('allows generic serialized output and payload without private provenance', () => {
  const root = fixture();
  const cases = [
    ['build-result.json', {
      output: { directory: 'dist', format: 'esm' },
    }],
    ['package-envelope.json', {
      payload: { name: 'selected-package', version: '1.2.3' },
    }],
    ['public-build-record.json', {
      source: 'build',
      type: 'module',
      output: 'dist/index.js',
      payload: { files: 3 },
    }],
  ];
  for (const [relative, value] of cases) {
    fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value)}\n`);
  }

  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.filesScanned, cases.length);
  assert.deepEqual(result.findings, []);
});

test('rejects ordinary credential, auth-state, prompt and advert representations', () => {
  const root = fixture();
  const credentialValue = ['SYNTHETIC', 'SECRET'].join('-');
  const cases = [
    ['credentials.json', { credentials: { [['to', 'ken'].join('')]: credentialValue } }, 'credential'],
    ['access-token.json', { [['access', 'Token'].join('')]: credentialValue }, 'credential'],
    ['auth-state.json', { authState: { provider: 'codex', [['to', 'ken'].join('')]: credentialValue } }, 'raw-auth-state'],
    ['login-response.json', { login: { response: { [['refresh', 'Token'].join('')]: credentialValue } } }, 'raw-auth-output'],
    ['provider-request.json', {
      request: { messages: [{ role: 'user', content: 'Synthetic private prompt body.' }] },
    }, 'full-prompt'],
    ['vacancy-body.json', {
      vacancy: { company: 'Synthetic employer', body: 'Synthetic private advert body.' },
    }, 'advert-body'],
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
  for (const [file, _value, rule] of cases) {
    assert.equal(
      result.findings.some((finding) => finding.file === file && finding.rule === rule),
      true,
      `${file} must report ${rule}`,
    );
  }
  assert.equal(JSON.stringify(result).includes('SYNTHETIC-SECRET'), false);
  assert.equal(JSON.stringify(result).includes('Synthetic private'), false);
});

test('rejects high-signal private fields across YAML and TOML syntax', () => {
  const root = fixture();
  const cases = [
    ['raw-run.yaml', 'rawRunState: synthetic-private-run-state\n', 'raw-run-state'],
    ['raw-run.yml', 'raw_run_state: synthetic-private-run-state\n', 'raw-run-state'],
    ['prompt.yaml', 'prompt: synthetic-private-prompt-body\n', 'full-prompt'],
    ['raw-run.toml', 'rawRunState = "synthetic-private-run-state"\n', 'raw-run-state'],
    ['prompt.toml', 'prompt = "synthetic-private-prompt-body"\n', 'full-prompt'],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), content);

  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map(({ file, rule }) => [file, rule]),
    cases.map(([file, _content, rule]) => [file, rule])
      .sort(([left], [right]) => left.localeCompare(right, 'en')),
  );
  assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
});

test('detects a serialized private payload by content after a harmless rename', () => {
  const root = fixture();
  const relative = 'docs/leak.md';
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), JSON.stringify({
    authState: { accessToken: ['SYNTHETIC', 'SECRET'].join('-') },
    prompt: 'Synthetic private prompt body.',
  }));
  const result = auditRelease({ root, trackedFiles: [relative], buildDirs: [] });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some(({ rule }) => rule === 'raw-auth-state'), true);
  assert.equal(result.findings.some(({ rule }) => rule === 'credential'), true);
  assert.equal(result.findings.some(({ rule }) => rule === 'full-prompt'), true);
});

test('default tracked-file audit does not exempt tests or fixtures', () => {
  const root = fixture();
  const marker = 'Casey Privateperson';
  const relative = 'tests/private.fixture.mjs';
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), `export const owner = '${marker}';\n`);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['add', relative], { cwd: root }).status, 0);
  const result = auditRelease({ root, buildDirs: [], markers: [marker] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{
    file: relative, line: 1, rule: 'personal-marker-1',
  }]);
});

test('rejects private runtime roots inside the staged app layout regardless of case or binary content', () => {
  const root = fixture();
  const cases = [
    ['app/Data/private.json', Buffer.from('{}\n')],
    ['app/.SCOUT/run.bin', Buffer.from([0, 47, 104, 111, 109, 101, 47, 112, 114, 105, 118, 97, 116, 101])],
  ];
  for (const [relative, content] of cases) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.findings.filter((finding) => finding.rule === 'private-runtime-artifact').length,
    cases.length,
  );
  assert.equal(result.findings.every((finding) => finding.file === '[redacted-path]'), true);
});

test('rejects private runtime roots inside the default nested release stage', () => {
  const root = fixture();
  const relative = 'dist/release/stage/app/Data/private.json';
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  const result = auditRelease({ root, trackedFiles: [], buildDirs: ['dist'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{
    file: '[redacted-path]', line: 1, rule: 'private-runtime-artifact',
  }]);
});

test('allows only the exact documented VPS paths after release app wrapping', () => {
  const root = fixture();
  const documented = [
    'app/docs/INSTALL_VPS.md',
    'app/docs/diagnostics/beta15-vps-workspace-incident.md',
    'app/tools/deploy-vps.sh',
    'dist/release/stage/app/docs/INSTALL_VPS.md',
  ];
  for (const relative of documented) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${unixHome('ubuntu', 'Documents/Scout Workspace')}\n${unixHome('scout-deploy', '.ssh/authorized_keys')}\n`);
  }
  const leaked = 'app/config/runtime.json';
  fs.mkdirSync(path.dirname(path.join(root, leaked)), { recursive: true });
  fs.writeFileSync(path.join(root, leaked), `${JSON.stringify({ workspace: unixHome('ubuntu', 'Documents/Scout Workspace') })}\n`);

  const documentedResult = auditRelease({ root, trackedFiles: documented, buildDirs: [] });
  assert.equal(documentedResult.ok, true);
  const leakedResult = auditRelease({ root, trackedFiles: [leaked], buildDirs: [] });
  assert.equal(leakedResult.ok, false);
  assert.deepEqual(leakedResult.findings.map(({ rule }) => rule), ['private-path']);
});

test('ignores documented placeholder credential assignments', () => {
  const root = fixture();
  const example = [
    `${'API'}_KEY=replace-me`,
    `${'ADZUNA'}_${'API'}_${'KEY'}=<your-api-key>`,
    `${'PASS'}WORD=<your-password>`,
    `${'GH'}_${'TOKEN'}: "\${{ github.token }}"`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'example.env'), example);
  const result = auditRelease({ root, trackedFiles: ['example.env'], buildDirs: [] });
  assert.equal(result.ok, true);
});

test('does not exempt plausible credentials merely wrapped as generic placeholders', () => {
  const root = fixture();
  const cases = [
    ['your-value.env', `${'ADZUNA'}_${'API'}_${'KEY'}=your-live-production-token-938472\n`],
    ['angle-value.env', `${'PASS'}${'WORD'}=<live-production-password>\n`],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), content);
  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ file, rule }) => ({ file, rule })), cases.map(([file]) => ({
    file,
    rule: 'secret-assignment',
  })).sort((a, b) => a.file.localeCompare(b.file, 'en')));
});

test('rejects plausible credentials even when their values contain fixture-like words', () => {
  const root = fixture();
  const cases = [
    ['production.env', `${'API'}_KEY=my-production-secret-value\n`],
    ['private.env', `${'AUTH'}_${'TOKEN'}=private-live-credential\n`],
    ['synthetic.env', `${'PASS'}WORD=synthetic-stolen-password\n`],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), content);
  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ file, rule }) => ({ file, rule })), cases.map(([file]) => ({
    file,
    rule: 'secret-assignment',
  })).sort((a, b) => a.file.localeCompare(b.file, 'en')));
});

test('rejects quoted credential assignments containing whitespace without reporting their values', () => {
  const root = fixture();
  const cases = [
    ['password.env', `${'PASS'}${'WORD'}="a long private password"\n`],
    ['auth-token.yaml', `${'AUTH'}_${'TOKEN'}: "live token value 123456"\n`],
    ['api-key.env', `${'API'}_${'KEY'}='long private key value'\n`],
    ['escaped-password.env', `${'PASS'}${'WORD'}="test\\"long private password"\n`],
    ['doubled-api-key.yaml', `${'API'}_${'KEY'}: 'test''long private key value'\n`],
    ['leading-doubled-password.yaml', `${'PASS'}${'WORD'}: '''long private password'\n`],
    ['static-token.mjs', `const ${'auth'}${'Token'} = \`long private token value\`;\n`],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), content);
  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ file, rule }) => ({ file, rule })), cases.map(([file]) => ({
    file,
    rule: 'secret-assignment',
  })).sort((a, b) => a.file.localeCompare(b.file, 'en')));
  assert.equal(JSON.stringify(result.findings).includes('private password'), false);
  assert.equal(JSON.stringify(result.findings).includes('token value'), false);
  assert.equal(JSON.stringify(result.findings).includes('private key'), false);
});

test('rejects namespaced credential assignment families without flagging unrelated code tokens', () => {
  const root = fixture();
  const cases = [
    ['adzuna.env', `${'ADZUNA'}_${'API'}_${'KEY'}="opaque live value 123456"\n`],
    ['openai.env', `${'OPENAI'}_${'API'}_${'KEY'}=opaque-live-value-123456\n`],
    ['database.env', `${'DB'}_${'PASS'}${'WORD'}='opaque database password'\n`],
    ['refresh.env', `${'REFRESH'}_${'TOKEN'}="opaque refresh value"\n`],
    ['bearer.env', `${'SERVICE'}_${'BEARER'}_${'TOKEN'}="opaque bearer value"\n`],
    ['identity.env', `${'ID'}_${'TOKEN'}="opaque identity value"\n`],
    ['session.env', `${'SESSION'}_${'TOKEN'}="opaque session value"\n`],
    ['quoted-key.yaml', `"${'SERVICE'}_${'TOKEN'}": "opaque quoted key value"\n`],
    ['api-token.mjs', `const ${'api'}${'Token'} = "opaque api token value";\n`],
    ['service-token.mjs', `const ${'service'}${'Token'} = "opaque service credential";\n`],
    ['provider-token.mjs', `const ${'provider'}${'Token'} = "opaque provider credential";\n`],
    ['github-token.mjs', `const ${'github'}${'Token'} = "opaque github credential";\n`],
    ['openai-token.mjs', `const ${'openai'}${'Token'} = "opaque openai credential";\n`],
    ['csrf-token.mjs', `const ${'csrf'}${'Token'} = "live csrf token 123456";\n`],
    ['provider-login-csrf.mjs', `const ${'providerLogin'}${'CsrfToken'} = "live provider csrf 123456";\n`],
    ['api-secret.mjs', `const ${'api'}${'Secret'} = "opaque api secret value";\n`],
    ['consumer-secret.mjs', `const ${'consumer'}${'Secret'} = "opaque consumer secret";\n`],
    ['authorization.mjs', `const ${'author'}${'ization'} = "Basic dXNlcjpwYXNzd29yZA==";\n`],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), content);
  fs.writeFileSync(
    path.join(root, 'source.mjs'),
    "const cancellationToken = operation.signal;\nconst csrfToken = `csrf-${provider}`;\nconst lockToken = 'fixture-lock-token';\n",
  );
  const result = auditRelease({
    root,
    trackedFiles: [...cases.map(([relative]) => relative), 'source.mjs'],
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ file, rule }) => ({ file, rule })), cases.map(([file]) => ({
    file,
    rule: 'secret-assignment',
  })).sort((a, b) => a.file.localeCompare(b.file, 'en')));
});

test('checks every sensitive assignment on a line and rejects bearer and provider tokens', () => {
  const root = fixture();
  const bearer = ['Authorization:', 'Bearer', 'liveBearerCredential123456'].join(' ');
  const providerToken = ['sk', 'liveProviderCredential123456'].join('-');
  const cases = [
    ['minified.env', `${'TOKEN'}=replace-me ${'PASSWORD'}=live-password-value\n`, 'secret-assignment'],
    ['authorization.txt', `${bearer}\n`, 'authorization-bearer'],
    ['provider.txt', `${providerToken}\n`, 'openai-token'],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), content);
  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  for (const [file, _content, rule] of cases) {
    assert.equal(
      result.findings.some((finding) => finding.file === file && finding.rule === rule),
      true,
      `${file} must report ${rule}`,
    );
  }
});

test('rejects serialized quoted Authorization Bearer headers', () => {
  const root = fixture();
  const relative = 'headers.json';
  const value = {
    [['Author', 'ization'].join('')]: ['Bearer', 'liveBearerCredential123456'].join(' '),
  };
  fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value)}\n`);
  const result = auditRelease({ root, trackedFiles: [relative], buildDirs: [] });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some(({ rule }) => rule === 'authorization-bearer'), true);
  assert.equal(result.findings.some(({ rule }) => rule === 'credential'), true);
});

test('rejects plausible private home paths without username exemptions', () => {
  const root = fixture();
  const cases = [
    ['mac.txt', macHome('user', 'Scout Workspace')],
    ['linux.txt', unixHome('user', 'Scout Workspace')],
    ['windows.txt', windowsHome('owner', 'Scout Workspace')],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), `${content}\n`);
  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ file, rule }) => ({ file, rule })), cases.map(([file]) => ({
    file,
    rule: 'private-path',
  })).sort((a, b) => a.file.localeCompare(b.file, 'en')));
});

test('rejects root, alternate Unix and UNC profiles plus usernames that only start like placeholders', () => {
  const root = fixture();
  const alternateUnix = (prefix, user, suffix) =>
    ['', ...prefix.split('/'), user, suffix].filter((part, index) => index === 0 || part).join('/');
  const cases = [
    ['root.txt', ['', 'root', '.scout'].join('/')],
    ['var-root.txt', ['', 'var', 'root', '.scout'].join('/')],
    ['mac-yourname.txt', macHome('yourname', 'Scout Workspace')],
    ['linux-yourself.txt', unixHome('yourself', 'Scout Workspace')],
    ['unix-youraccount.txt', alternateUnix('usr/home', 'YourAccount', 'Scout Workspace')],
    ['unix-mixed-case.txt', alternateUnix('export/home', 'yOuRnAmE', 'Scout Workspace')],
    ['windows-youraccount.txt', windowsHome('YourAccount', 'Scout Workspace')],
    ['unc-users.txt', uncHome('Users', 'yourname', 'Scout Workspace')],
    ['unc-users.json', JSON.stringify({ path: uncHome('Users', 'YourAccount', 'Scout Workspace') })],
    ['unc-homes.txt', uncHome('homes', 'yourself', 'Scout Workspace')],
    ['unc-profiles.txt', uncHome('profiles', 'YourAccount', 'Scout Workspace')],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), `${content}\n`);

  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ file, rule }) => ({ file, rule })), cases.map(([file]) => ({
    file,
    rule: 'private-path',
  })).sort((a, b) => a.file.localeCompare(b.file, 'en')));
  for (const [_relative, content] of cases) assert.equal(JSON.stringify(result).includes(content), false);
});

test('allows only exact segment-bounded public and placeholder profile names', () => {
  const root = fixture();
  const angleUser = ['<', 'user', '>'].join('');
  const cases = [
    ['mac-shared.txt', macHome('Shared', 'Scout')],
    ['mac-public.txt', macHome('Public', 'Scout')],
    ['mac-placeholder.txt', macHome('YOUR', 'Scout')],
    ['linux-placeholder.txt', unixHome('your', 'Scout')],
    ['linux-angle-placeholder.txt', unixHome(angleUser, 'Scout')],
    ['windows-public.txt', windowsHome('Public', 'Scout')],
    ['windows-placeholder.txt', windowsHome('Your', 'Scout')],
    ['unc-placeholder.txt', uncHome('profiles', 'YOUR', 'Scout')],
  ];
  for (const [relative, content] of cases) fs.writeFileSync(path.join(root, relative), `${content}\n`);

  const result = auditRelease({
    root,
    trackedFiles: cases.map(([relative]) => relative),
    buildDirs: [],
  });

  assert.equal(result.ok, true);
});

test('ignores credential variable expressions and exact allowlisted binary assets', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'source.mjs'), "const apiKey = String(env.ADZUNA_API_KEY || '').trim();\nconst token = crypto.randomUUID();\n");
  const binaries = [
    'ui/assets/scout-icon.png',
    'deb/usr/share/icons/hicolor/512x512/apps/scout.png',
    'runtime/ScoutRuntime.exe',
    'Scout.exe',
    'dmg-root/Scout.app/Contents/MacOS/Scout',
  ];
  for (const relative of binaries) {
    const binary = path.join(root, relative);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, relative.endsWith('/scout-icon.png') || relative.endsWith('/scout.png')
      ? fs.readFileSync(new URL('../ui/assets/scout-icon.png', import.meta.url))
      : Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));
  }
  const result = auditRelease({ root, trackedFiles: ['source.mjs', ...binaries], buildDirs: [] });
  assert.equal(result.ok, true);
  assert.equal(result.filesScanned, 6);
});

test('rejects replacement content at the exact installed Linux icon path', () => {
  const root = fixture();
  const relative = 'deb/usr/share/icons/hicolor/512x512/apps/scout.png';
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));

  const result = auditRelease({ root, trackedFiles: [relative], buildDirs: [] });

  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{
    file: relative, line: 1, rule: 'reviewed-binary-digest-mismatch',
  }]);
});

test('rejects replacement content at an exact allowlisted public screenshot path', () => {
  const root = fixture();
  const relative = 'docs/screenshots/0.1.0-beta.23/trustworthy-model-picker.png';
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));

  const result = auditRelease({ root, trackedFiles: [relative], buildDirs: [] });

  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{
    file: relative, line: 1, rule: 'reviewed-binary-digest-mismatch',
  }]);
});

test('rejects arbitrary packaged binary documents and screenshots outside exact public allowlists', () => {
  const root = fixture();
  const cases = [
    ['app/ui/assets/master-cv.pdf', '%PDF-1.7\nSynthetic private CV text\n%%EOF\n'],
    ['docs/screenshots/private/private.png', Buffer.from([137, 80, 78, 71, 0, 1, 2, 3])],
  ];
  for (const [relative, content] of cases) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const result = auditRelease({ root, trackedFiles: cases.map(([relative]) => relative), buildDirs: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, cases.map(([file]) => ({
    file, line: 1, rule: 'unexpected-binary',
  })).sort((left, right) => left.file.localeCompare(right.file, 'en')));
});

test('rejects personal markers in filenames without echoing the private path', () => {
  const root = fixture();
  const marker = 'Casey Exampleperson';
  const relative = 'app/docs/Casey-Exampleperson-notes.md';
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'generic release note\n');
  const result = auditRelease({ root, trackedFiles: [relative], buildDirs: [], markers: [marker] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{
    file: '[redacted-path]', line: 1, rule: 'personal-marker-path-1',
  }]);
  assert.equal(JSON.stringify(result).includes('Casey'), false);
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

test('stage mode audits installed dependency JSON, YAML, TOML, text, log and runtime payloads', () => {
  const root = fixture();
  const marker = 'Synthetic Dependency Private Marker';
  fs.mkdirSync(path.join(root, 'app', 'node_modules', 'selected-package', '.scout'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, 'app', 'README.md'), '# Scout\n');
  fs.writeFileSync(
    path.join(root, 'app', 'node_modules', 'selected-package', 'private.json'),
    JSON.stringify({ prompt: 'Synthetic private provider prompt.' }),
  );
  fs.writeFileSync(
    path.join(root, 'app', 'node_modules', 'selected-package', 'private.txt'),
    `${marker}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'app', 'node_modules', 'selected-package', 'provider.log'),
    'provider_transcript: synthetic-private-provider-output\n',
  );
  fs.writeFileSync(
    path.join(root, 'app', 'node_modules', 'selected-package', 'private.yaml'),
    'prompt: synthetic-private-provider-prompt\n',
  );
  fs.writeFileSync(
    path.join(root, 'app', 'node_modules', 'selected-package', 'run-state.toml'),
    'rawRunState = "synthetic-private-run-state"\n',
  );
  fs.writeFileSync(
    path.join(root, 'app', 'node_modules', 'selected-package', 'package-metadata.json'),
    JSON.stringify({
      output: 'dist/index.js',
      payload: { name: 'selected-package', version: '1.2.3' },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'app', 'node_modules', 'selected-package', '.scout', 'run-state.jsonl'),
    `${JSON.stringify({ events: [{ stage: 'synthetic-private-stage' }] })}\n`,
  );

  const sourceAudit = auditRelease({
    root,
    trackedFiles: ['app/README.md'],
    buildDirs: ['app/node_modules'],
    markers: [marker],
  });
  assert.equal(sourceAudit.ok, true);
  assert.equal(sourceAudit.filesScanned, 1);

  const writes = [];
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  process.stdout.write = (value) => { writes.push(String(value)); return true; };
  try {
    const stagedAudit = main(['--root', root, '--stage'], {
      SCOUT_RELEASE_MARKERS: marker,
    });
    assert.equal(stagedAudit.ok, false);
    assert.equal(stagedAudit.filesScanned, 8);
    assert.deepEqual(
      stagedAudit.findings.map(({ file, rule }) => [file, rule]),
      [
        ['app/node_modules/selected-package/.scout/run-state.jsonl', 'raw-run-state'],
        ['app/node_modules/selected-package/private.json', 'full-prompt'],
        ['app/node_modules/selected-package/private.txt', 'personal-marker-1'],
        ['app/node_modules/selected-package/private.yaml', 'full-prompt'],
        ['app/node_modules/selected-package/provider.log', 'provider-transcript'],
        ['app/node_modules/selected-package/run-state.toml', 'raw-run-state'],
      ],
    );
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
  assert.match(writes.join(''), /Release audit failed with 6 finding/);
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

  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.findings.some(({ file }) => file.endsWith('.test.mjs')), false);
});
