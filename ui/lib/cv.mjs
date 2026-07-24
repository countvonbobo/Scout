import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from './atomicWrite.mjs';
import { resolveTypstRuntime } from './typstRuntime.mjs';

const SLUG = /^[a-z0-9-]+$/;
const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDER_TIMEOUT_MS = 60_000;

export function safeCvPath(repoRoot, relPath) {
  const rel = String(relPath).replace(/\\/g, '/');
  if (rel === 'cv/master-cv.md') return path.resolve(repoRoot, rel);
  const m = rel.match(/^applications\/([^/]+)\/(cv\.typ|outreach\.md)$/);
  if (m && SLUG.test(m[1])) return path.resolve(repoRoot, rel);
  throw new Error(`invalid CV path: ${relPath}`);
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function manifestFile(root) { return path.join(root, '.scout', 'cv-renders.json'); }

function readManifest(root) {
  try { return JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')); }
  catch { return { schemaVersion: 1, renders: {} }; }
}

function writeManifest(root, manifest) {
  atomicWriteFile(manifestFile(root), `${JSON.stringify(manifest, null, 2)}\n`);
}

function checkedTarget(root, { target = 'application', slug = '' } = {}) {
  if (target === 'master') {
    return {
      target, key: 'master', slug: null, source: path.join(root, 'cv', 'master-cv.md'),
      typst: path.join(root, '.scout', 'rendered', 'master-cv.typ'),
      pdf: path.join(root, '.scout', 'rendered', 'master-cv.pdf'),
    };
  }
  if (target !== 'application') throw new Error(`invalid CV render target: ${target}`);
  if (!SLUG.test(String(slug))) throw new Error(`invalid slug: ${slug}`);
  safeCvPath(root, `applications/${slug}/cv.typ`);
  return {
    target, key: `application:${slug}`, slug, source: path.join(root, 'applications', slug, 'cv.typ'),
    typst: path.join(root, 'applications', slug, 'cv.typ'), pdf: path.join(root, 'applications', slug, 'cv.pdf'),
  };
}

function plainMarkdownText(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1').replace(/^>\s*/, '').trim();
}

export function masterMarkdownToTypst(markdown) {
  const withoutEvidenceComments = String(markdown || '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = ['#set page(paper: "a4", margin: (x: 18mm, y: 16mm))', '#set text(size: 10pt)', '#set par(justify: false, leading: 0.62em)', ''];
  for (const raw of withoutEvidenceComments.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { lines.push(''); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      lines.push(`${'='.repeat(heading[1].length)} #text(${JSON.stringify(plainMarkdownText(heading[2]))})`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) { lines.push(`- #text(${JSON.stringify(plainMarkdownText(bullet[1]))})`); continue; }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) { lines.push(`+ #text(${JSON.stringify(plainMarkdownText(numbered[1]))})`); continue; }
    if (/^[-*_]{3,}$/.test(line)) { lines.push('#line(length: 100%)'); continue; }
    lines.push(`#text(${JSON.stringify(plainMarkdownText(line))})`);
  }
  return `${lines.join('\n')}\n`;
}

function prepareTarget(root, descriptor) {
  if (!fs.existsSync(descriptor.source)) throw new Error(descriptor.target === 'master' ? 'The master CV does not exist.' : `CV source does not exist: applications/${descriptor.slug}/cv.typ`);
  const source = fs.readFileSync(descriptor.source, 'utf8');
  if (descriptor.target === 'master') atomicWriteFile(descriptor.typst, masterMarkdownToTypst(source));
  fs.mkdirSync(path.dirname(descriptor.pdf), { recursive: true });
  return { ...descriptor, sourceSha256: sha256(source) };
}

function relative(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
function temporaryPdf(file) { return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`); }

function validPdf(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 20) return false;
  const handle = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(5);
    fs.readSync(handle, header, 0, header.length, 0);
    return header.toString('ascii') === '%PDF-';
  } finally { fs.closeSync(handle); }
}

function finishRender(root, descriptor, temp, now = () => new Date().toISOString()) {
  if (!validPdf(temp)) throw new Error('Typst did not produce a valid PDF. The previous PDF was kept.');
  fs.renameSync(temp, descriptor.pdf);
  const manifest = readManifest(root);
  manifest.schemaVersion = 1;
  manifest.renders ||= {};
  manifest.renders[descriptor.key] = { sourceSha256: descriptor.sourceSha256, renderedAt: now() };
  writeManifest(root, manifest);
  return { ok: true, target: descriptor.target, slug: descriptor.slug, renderedAt: manifest.renders[descriptor.key].renderedAt };
}

function compileArgs(root, descriptor, temp) {
  return ['compile', '--root', '.', '--format', 'pdf', relative(root, descriptor.typst), relative(root, temp)];
}

async function runTypst(command, args, { cwd, timeoutMs, spawnImpl }) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PDF rendering timed out after ${Math.round(timeoutMs / 1000)} seconds. The previous PDF was kept.`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error((stderr || stdout || `Typst exited with code ${code}`).trim()));
    });
  });
}

export async function renderCvTarget(root, request, {
  appRoot = DEFAULT_APP_ROOT, runtimeResolver = resolveTypstRuntime, spawnImpl = spawn,
  timeoutMs = RENDER_TIMEOUT_MS, now,
} = {}) {
  const descriptor = prepareTarget(root, checkedTarget(root, request));
  const runtime = runtimeResolver({ appRoot });
  if (!runtime.available) throw new Error(runtime.error || "Scout's Typst runtime is unavailable. Repair or reinstall Scout.");
  const temp = temporaryPdf(descriptor.pdf);
  try {
    await runTypst(runtime.command, compileArgs(root, descriptor, temp), { cwd: root, timeoutMs, spawnImpl });
    return finishRender(root, descriptor, temp, now);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    if (error?.code === 'ENOENT') throw new Error("Scout's Typst runtime disappeared while rendering. Repair or reinstall Scout.");
    throw error;
  }
}

// The CLI quality command may block its own short-lived process, but server routes use renderCvTarget.
export function renderCv(root, slug, {
  appRoot = DEFAULT_APP_ROOT, runtimeResolver = resolveTypstRuntime, spawnSyncImpl = spawnSync, timeoutMs = RENDER_TIMEOUT_MS, now,
} = {}) {
  let descriptor;
  try { descriptor = prepareTarget(root, checkedTarget(root, { target: 'application', slug })); }
  catch (error) { return { ok: false, stdout: '', stderr: error.message }; }
  const runtime = runtimeResolver({ appRoot });
  if (!runtime.available) return { ok: false, stdout: '', stderr: runtime.error, runtime };
  const temp = temporaryPdf(descriptor.pdf);
  const result = spawnSyncImpl(runtime.command, compileArgs(root, descriptor, temp), { cwd: root, encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  if (result.error) {
    fs.rmSync(temp, { force: true });
    return { ok: false, stdout: '', stderr: result.error.code === 'ENOENT' ? "Scout's Typst runtime disappeared while rendering. Repair or reinstall Scout." : result.error.message };
  }
  if (result.status !== 0) {
    fs.rmSync(temp, { force: true });
    return { ok: false, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
  }
  try { return { ...finishRender(root, descriptor, temp, now), stdout: '', stderr: '', runtime }; }
  catch (error) { fs.rmSync(temp, { force: true }); return { ok: false, stdout: '', stderr: error.message, runtime }; }
}

export function cvRenderState(root, request) {
  const descriptor = checkedTarget(root, request);
  if (!fs.existsSync(descriptor.source)) return { pdf: false, current: false, stale: false, renderedAt: null };
  const record = readManifest(root).renders?.[descriptor.key];
  const pdf = fs.existsSync(descriptor.pdf);
  const currentHash = sha256(fs.readFileSync(descriptor.source));
  const current = Boolean(pdf && record?.sourceSha256 === currentHash && validPdf(descriptor.pdf));
  return { pdf, current, stale: pdf && !current, renderedAt: record?.renderedAt || null };
}

export function cvPdfPath(root, request) {
  const descriptor = checkedTarget(root, request);
  const state = cvRenderState(root, request);
  if (!state.current) throw new Error(state.stale ? 'PDF is stale — render this CV again.' : 'No current PDF — render this CV first.');
  return descriptor.pdf;
}

export function listCvFiles(root) {
  const appsDir = path.join(root, 'applications');
  let applications = [];
  let outreach = [];
  if (fs.existsSync(appsDir)) {
    const dirs = fs.readdirSync(appsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SLUG.test(entry.name)).map((entry) => entry.name).sort();
    applications = dirs.filter((slug) => fs.existsSync(path.join(appsDir, slug, 'cv.typ')));
    outreach = dirs.filter((slug) => fs.existsSync(path.join(appsDir, slug, 'outreach.md')));
  }
  const entries = applications.map((slug) => {
    const directory = path.join(appsDir, slug);
    const render = cvRenderState(root, { target: 'application', slug });
    return {
      slug, source: true, pdf: render.pdf, pdfCurrent: render.current, pdfStale: render.stale, renderedAt: render.renderedAt,
      outreach: fs.existsSync(path.join(directory, 'outreach.md')), evidence: fs.existsSync(path.join(directory, 'cv-evidence.json')),
      quality: fs.existsSync(path.join(directory, 'cv-quality.json')),
    };
  });
  return { master: 'cv/master-cv.md', masterRender: cvRenderState(root, { target: 'master' }), applications, outreach, entries };
}
