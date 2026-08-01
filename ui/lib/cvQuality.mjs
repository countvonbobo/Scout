import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { withWorkspaceMutationAuthority } from './workspaceMutationAuthority.mjs';
import { renderCv } from './cv.mjs';

const SLUG = /^[a-z0-9-]+$/;
export const CV_EVIDENCE_SCHEMA = 1;
export const CV_QUALITY_SCHEMA = 1;

export const GENERIC_CV_CLICHES = Object.freeze([
  'results-driven',
  'dynamic professional',
  'proven track record',
  'go-getter',
  'think outside the box',
  'synergy',
]);

const US_TO_UK = Object.freeze({
  optimized: 'optimised', optimizing: 'optimising', organization: 'organisation',
  organizations: 'organisations', center: 'centre', centered: 'centred',
  color: 'colour', colors: 'colours', analyze: 'analyse', analyzed: 'analysed',
});

function checkedSlug(slug) {
  const value = String(slug || '');
  if (!SLUG.test(value)) throw new Error(`invalid CV slug: ${slug}`);
  return value;
}

export function cvQualityPaths(root, slug) {
  const safe = checkedSlug(slug);
  const directory = path.resolve(root, 'applications', safe);
  return Object.freeze({
    directory,
    source: path.join(directory, 'cv.typ'),
    pdf: path.join(directory, 'cv.pdf'),
    evidence: path.join(directory, 'cv-evidence.json'),
    quality: path.join(directory, 'cv-quality.json'),
  });
}

export function sourceSha256(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function visibleText(value) {
  return String(value || '')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/#?link\([^)]*\)\[([^\]]*)\]/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\\([~#*_])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTypstBullets(source) {
  const bullets = [];
  let current = null;
  for (const raw of String(source || '').split(/\r?\n/)) {
    const start = raw.match(/^\s*-\s+(.+)$/);
    if (start) {
      if (current) bullets.push(visibleText(current.join(' ')));
      current = [start[1]];
      continue;
    }
    if (current && /^\s{2,}\S/.test(raw) && !/^\s*\/\//.test(raw)) {
      current.push(raw.trim());
      continue;
    }
    if (current) {
      bullets.push(visibleText(current.join(' ')));
      current = null;
    }
  }
  if (current) bullets.push(visibleText(current.join(' ')));
  return bullets.filter(Boolean);
}

function issue(id, severity, message, bullet = null) {
  return { id, severity, message, ...(bullet ? { bullet } : {}) };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalisedEvidenceBullets(manifest) {
  return (Array.isArray(manifest?.bullets) ? manifest.bullets : []).map((entry) => ({
    ...entry,
    normalisedText: visibleText(entry?.text),
  }));
}

export function assessCvSource(source, manifest, { locale = 'en-GB', pdfExists = true } = {}) {
  const issues = [];
  const bullets = extractTypstBullets(source);
  const evidenceBullets = normalisedEvidenceBullets(manifest);
  const options = {
    xyz: manifest?.options?.xyz === true,
    humanize: manifest?.options?.humanize === true,
  };

  if (!pdfExists) issues.push(issue('pdf-missing', 'block', 'The compiled PDF is missing.'));
  if (!manifest || manifest.schemaVersion !== CV_EVIDENCE_SCHEMA) {
    issues.push(issue('evidence-missing', 'block', 'A valid cv-evidence.json record is required.'));
  }
  const visible = visibleText(source);
  if (/\b(?:TODO|TBC|TBD|FIXME|XX+)\b|<[^>\n]+>/i.test(visible)) {
    issues.push(issue('placeholder', 'block', 'The CV contains an unresolved visible placeholder.'));
  }

  for (const bullet of bullets) {
    const record = evidenceBullets.find((entry) => entry.normalisedText === bullet);
    if (!record || !Array.isArray(record.evidence) || record.evidence.length === 0) {
      issues.push(issue('unsupported-bullet', 'block', 'Every bullet needs at least one recorded evidence source.', bullet));
      continue;
    }
    if (record.evidence.some((sourceEntry) => !sourceEntry?.source || !sourceEntry?.reference)) {
      issues.push(issue('invalid-evidence', 'block', 'Evidence entries require both source and reference.', bullet));
    }
    if (options.xyz && record.kind === 'achievement') {
      const xyz = record.xyz || {};
      if (![xyz.x, xyz.y, xyz.z].every((part) => typeof part === 'string' && part.trim())) {
        issues.push(issue('xyz-incomplete', 'warning', 'Achievement bullets need confirmed X, Y and Z components.', bullet));
      }
    }
  }

  if (options.humanize) {
    if (manifest?.voiceReview?.completed !== true) {
      issues.push(issue('voice-review-missing', 'warning', 'The separate natural-voice review has not been recorded.'));
    }
    const lower = visible.toLocaleLowerCase('en-US');
    for (const phrase of GENERIC_CV_CLICHES) {
      if (lower.includes(phrase)) issues.push(issue('cliche', 'warning', `Replace the generic phrase “${phrase}”.`));
    }
    const openings = new Map();
    for (const bullet of bullets) {
      const first = bullet.toLocaleLowerCase('en-US').match(/[a-z]+/)?.[0];
      if (first) openings.set(first, (openings.get(first) || 0) + 1);
      if (bullet.split(/\s+/).filter(Boolean).length > 55) {
        issues.push(issue('long-bullet', 'warning', 'Keep this bullet to 55 words or fewer.', bullet));
      }
    }
    for (const [verb, count] of openings) {
      if (count >= 3) issues.push(issue('repeated-opening', 'warning', `${count} bullets begin with “${verb}”; vary the openings.`));
    }
    if (/^en-GB\b/i.test(locale)) {
      for (const [us, uk] of Object.entries(US_TO_UK)) {
        if (new RegExp(`\\b${us}\\b`, 'i').test(visible)) {
          issues.push(issue('locale', 'warning', `Use “${uk}” rather than “${us}” for UK English.`));
        }
      }
    }
  }

  const blocking = issues.filter((entry) => entry.severity === 'block');
  const warnings = issues.filter((entry) => entry.severity === 'warning');
  return { options, bulletCount: bullets.length, evidenceBulletCount: evidenceBullets.length, issues, blocking, warnings, pass: issues.length === 0 };
}

export function runCvQuality(root, slug, {
  locale = 'en-GB', compile = true, now = () => new Date().toISOString(), appRoot,
} = {}) {
  return withWorkspaceMutationAuthority(root, {
    kind: 'cv-quality', phase: 'review-cv',
  }, () => {
  const paths = cvQualityPaths(root, slug);
  if (!fs.existsSync(paths.source)) throw new Error(`CV source does not exist: applications/${slug}/cv.typ`);
  let render = { ok: fs.existsSync(paths.pdf), stdout: '', stderr: '' };
  if (compile) render = renderCv(root, slug, { appRoot });
  const source = fs.readFileSync(paths.source, 'utf8');
  let manifest = null;
  let manifestError = null;
  if (fs.existsSync(paths.evidence)) {
    try { manifest = readJson(paths.evidence); } catch (error) { manifestError = error.message; }
  }
  const assessment = assessCvSource(source, manifest, { locale, pdfExists: render.ok && fs.existsSync(paths.pdf) });
  if (manifestError) assessment.issues.unshift(issue('evidence-invalid', 'block', `cv-evidence.json is invalid: ${manifestError}`));
  if (!render.ok) assessment.issues.unshift(issue('compile-failed', 'block', render.stderr || render.stdout || 'Typst compilation failed.'));
  assessment.blocking = assessment.issues.filter((entry) => entry.severity === 'block');
  assessment.warnings = assessment.issues.filter((entry) => entry.severity === 'warning');
  assessment.pass = assessment.issues.length === 0;
  const previous = fs.existsSync(paths.quality) ? (() => { try { return readJson(paths.quality); } catch { return null; } })() : null;
  const hash = sourceSha256(source);
  const report = {
    schemaVersion: CV_QUALITY_SCHEMA,
    cvSha256: hash,
    checkedAt: now(),
    ...assessment,
    render,
    override: previous?.override?.cvSha256 === hash ? previous.override : null,
  };
  atomicWriteFile(paths.quality, `${JSON.stringify(report, null, 2)}\n`);
  return report;
  });
}

export function readCvQuality(root, slug) {
  const paths = cvQualityPaths(root, slug);
  if (!fs.existsSync(paths.source)) throw new Error('CV source does not exist');
  const source = fs.readFileSync(paths.source, 'utf8');
  const hash = sourceSha256(source);
  if (!fs.existsSync(paths.quality)) {
    return { status: 'legacy', cvSha256: hash, pass: false, blocking: [], warnings: [issue('legacy', 'warning', 'This CV predates quality records.')], issues: [], override: null };
  }
  let report;
  try { report = readJson(paths.quality); } catch (error) {
    return { status: 'invalid', cvSha256: hash, pass: false, blocking: [issue('quality-invalid', 'block', error.message)], warnings: [], issues: [], override: null };
  }
  if (report.cvSha256 !== hash) {
    return { ...report, status: 'stale', currentCvSha256: hash, pass: false, override: null,
      warnings: [], blocking: [issue('stale', 'block', 'The CV changed after its last quality review. Run the review again.')] };
  }
  const overrideValid = report.override?.cvSha256 === hash;
  return { ...report, status: report.pass ? 'ready' : overrideValid ? 'overridden' : 'draft', overrideValid };
}

export function overrideCvQuality(root, slug, expectedHash, { now = () => new Date().toISOString() } = {}) {
  return withWorkspaceMutationAuthority(root, {
    kind: 'cv-quality', phase: 'override-cv',
  }, () => {
  const paths = cvQualityPaths(root, slug);
  const current = readCvQuality(root, slug);
  const hash = current.currentCvSha256 || current.cvSha256;
  if (!expectedHash || expectedHash !== hash) throw new Error('CV changed; review the latest version before overriding');
  if ((current.blocking || []).length) throw new Error('Blocking quality failures cannot be overridden');
  let report = current;
  if (!fs.existsSync(paths.quality) || ['legacy', 'stale'].includes(current.status)) {
    report = {
      schemaVersion: CV_QUALITY_SCHEMA, cvSha256: hash, checkedAt: now(), legacy: true,
      options: { xyz: false, humanize: false }, pass: false, blocking: [],
      warnings: current.warnings || [], issues: current.warnings || [], render: { ok: fs.existsSync(paths.pdf) },
    };
  }
  report.override = { cvSha256: hash, acceptedAt: now() };
  atomicWriteFile(paths.quality, `${JSON.stringify(report, null, 2)}\n`);
  return readCvQuality(root, slug);
  });
}

export function cvDownloadDecision(root, slug) {
  const quality = readCvQuality(root, slug);
  if (quality.status === 'ready' || quality.status === 'overridden') return { allowed: true, quality };
  return {
    allowed: false,
    overridable: (quality.blocking || []).length === 0,
    error: (quality.blocking || []).length ? 'CV has blocking quality failures' : 'CV is still a draft',
    quality,
  };
}
