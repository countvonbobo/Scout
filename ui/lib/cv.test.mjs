import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { cvRenderState, listCvFiles, masterMarkdownToTypst, renderCv, renderCvTarget, safeCvPath } from './cv.mjs';

const ROOT = 'C:/repo';

test('accepts the master CV', () => {
  assert.equal(safeCvPath(ROOT, 'cv/master-cv.md'), path.resolve(ROOT, 'cv/master-cv.md'));
});

test('accepts a well-formed application cv.typ and outreach.md', () => {
  assert.equal(
    safeCvPath(ROOT, 'applications/seeing-systems/cv.typ'),
    path.resolve(ROOT, 'applications/seeing-systems/cv.typ'),
  );
  assert.equal(
    safeCvPath(ROOT, 'applications/seeing-systems/outreach.md'),
    path.resolve(ROOT, 'applications/seeing-systems/outreach.md'),
  );
});

test('rejects traversal and off-whitelist paths', () => {
  assert.throws(() => safeCvPath(ROOT, '../secrets.txt'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'applications/../../etc/passwd'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'profile/context.md'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'applications/seeing-systems/notes.txt'), /invalid/i);
  assert.throws(() => safeCvPath(ROOT, 'applications/Bad Slug/cv.typ'), /invalid/i);
});

test('renderCv rejects invalid slugs before shelling out', () => {
  const result = renderCv(ROOT, '../../profile/context');
  assert.equal(result.ok, false);
  assert.match(result.stderr, /invalid slug/i);
});

test('lists legacy CV sources even when their PDFs and quality records are absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cv-list-'));
  try {
    fs.mkdirSync(path.join(root, 'applications', 'legacy-role'), { recursive: true });
    fs.writeFileSync(path.join(root, 'applications', 'legacy-role', 'cv.typ'), 'Legacy source');
    const result = listCvFiles(root);
    assert.deepEqual(result.applications, ['legacy-role']);
    assert.deepEqual(result.entries, [{
      slug: 'legacy-role', source: true, pdf: false, pdfCurrent: false, pdfStale: false, renderedAt: null,
      outreach: false, evidence: false, quality: false,
    }]);
    assert.deepEqual(result.masterRender, { pdf: false, current: false, stale: false, renderedAt: null });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('renders with the resolved managed Typst executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cv-render-'));
  try {
    fs.mkdirSync(path.join(root, 'applications', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.typ'), 'Example');
    let invocation;
    const result = renderCv(root, 'example', {
      appRoot: 'C:/app',
      runtimeResolver: () => ({ available: true, command: 'C:/app/.scout-runtime/typst.exe', source: 'managed', version: 'typst 0.14.2' }),
      spawnSyncImpl: (command, args, options) => {
        invocation = { command, args, options };
        fs.writeFileSync(path.join(root, args.at(-1)), '%PDF-1.7\nsynthetic valid pdf body');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(invocation.command, 'C:/app/.scout-runtime/typst.exe');
    assert.deepEqual(invocation.args.slice(0, 6), ['compile', '--root', '.', '--format', 'pdf', 'applications/example/cv.typ']);
    assert.match(invocation.args.at(-1), /\.tmp$/);
    assert.equal(cvRenderState(root, { target: 'application', slug: 'example' }).current, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('master Markdown becomes safe Typst without evidence comments', () => {
  const typst = masterMarkdownToTypst('# Example Person\n\n<!-- evidence: private-reference -->\n## Experience\n- Built [systems](https://example.test) with **care** and # symbols.');
  assert.match(typst, /= #text\("Example Person"\)/);
  assert.match(typst, /Built systems \(https:\/\/example\.test\) with care and # symbols/);
  assert.doesNotMatch(typst, /private-reference/);
});

function successfulSpawn(root) {
  return (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    process.nextTick(() => {
      fs.writeFileSync(path.join(root, args.at(-1)), '%PDF-1.7\nsynthetic valid pdf body');
      child.emit('close', 0);
    });
    return child;
  };
}

test('background master rendering is atomic and becomes stale after a source edit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-master-render-'));
  try {
    fs.mkdirSync(path.join(root, 'cv'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cv', 'master-cv.md'), '# Synthetic Master\n\n' + 'Evidence-led content. '.repeat(30));
    const result = await renderCvTarget(root, { target: 'master' }, {
      runtimeResolver: () => ({ available: true, command: 'typst' }), spawnImpl: successfulSpawn(root),
    });
    assert.equal(result.ok, true);
    assert.equal(cvRenderState(root, { target: 'master' }).current, true);
    fs.appendFileSync(path.join(root, 'cv', 'master-cv.md'), '\nChanged source.\n');
    assert.deepEqual(cvRenderState(root, { target: 'master' }), {
      pdf: true, current: false, stale: true, renderedAt: result.renderedAt,
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('background rendering times out without replacing the previous PDF', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-render-timeout-'));
  try {
    fs.mkdirSync(path.join(root, 'applications', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.typ'), '= Example');
    fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.pdf'), '%PDF-1.7\nprevious valid pdf body');
    const stalled = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      return child;
    };
    await assert.rejects(renderCvTarget(root, { target: 'application', slug: 'example' }, {
      runtimeResolver: () => ({ available: true, command: 'typst' }), spawnImpl: stalled, timeoutMs: 5,
    }), /timed out/);
    assert.equal(fs.readFileSync(path.join(root, 'applications', 'example', 'cv.pdf'), 'utf8'), '%PDF-1.7\nprevious valid pdf body');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reports a Scout repair action when no Typst runtime is usable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cv-missing-runtime-'));
  try {
    fs.mkdirSync(path.join(root, 'applications', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'applications', 'example', 'cv.typ'), 'Example');
    const result = renderCv(root, 'example', {
      runtimeResolver: () => ({ available: false, error: "Scout's managed Typst runtime is missing. Repair or reinstall Scout." }),
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /repair or reinstall Scout/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
