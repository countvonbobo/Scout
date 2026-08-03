import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RELEASE_FILES } from './build-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const commonMojibake = new RegExp('\\u00c3.|\\u00c2.|\\u00e2\\u20ac|\\ufffd');

function markdownFiles(directory = root) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute);
  }
  return files;
}

function userFacingSourceFiles(directory = root) {
  const files = [];
  const extensions = new Set(['.html', '.js', '.json', '.md', '.mjs', '.webmanifest']);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name) || entry.name === 'docs') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...userFacingSourceFiles(absolute));
    else if (entry.isFile() && !entry.name.includes('.test.') && extensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function currentGuide(file) {
  const name = relative(file);
  return !name.startsWith('docs/releases/');
}

function versionNeutralGuide(file) {
  const name = relative(file);
  return currentGuide(file) && name !== 'docs/KNOWN_ISSUES.md' && !name.startsWith('docs/diagnostics/');
}

function markdownTargets(content) {
  const targets = [];
  const pattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of content.matchAll(pattern)) targets.push(match[1].replace(/^<|>$/g, ''));
  return targets;
}

function includedInRelease(name) {
  return RELEASE_FILES.some((entry) => {
    if (entry.tree) return name === entry.source || name.startsWith(`${entry.source}/`);
    return name === entry.source;
  });
}

test('all local Markdown links resolve', () => {
  const broken = [];
  for (const file of markdownFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    for (const target of markdownTargets(content)) {
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const pathname = decodeURIComponent(target.split('#')[0]);
      if (!pathname) continue;
      const resolved = path.resolve(path.dirname(file), pathname);
      if (!fs.existsSync(resolved)) broken.push(`${relative(file)} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('relative links in packaged Markdown stay inside the release bundle', () => {
  const missing = [];
  for (const file of markdownFiles().filter((item) => includedInRelease(relative(item)))) {
    const content = fs.readFileSync(file, 'utf8');
    for (const target of markdownTargets(content)) {
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const pathname = decodeURIComponent(target.split('#')[0]);
      if (!pathname) continue;
      const targetName = relative(path.resolve(path.dirname(file), pathname));
      if (!includedInRelease(targetName)) missing.push(`${relative(file)} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('current documentation has no completed hosting handoff or stale release labels', () => {
  assert.equal(fs.existsSync(path.join(root, 'REMOTE_HOSTING_TODO.md')), false);
  const findings = [];
  for (const file of markdownFiles().filter(versionNeutralGuide)) {
    const content = fs.readFileSync(file, 'utf8');
    if (/REMOTE_HOSTING_TODO\.md|codex\/beta13-release-candidate|Beta\.5\b|Beta 13(?:'s)?\b|0\.1\.0-beta\.13/i.test(content)) {
      findings.push(relative(file));
    }
  }
  assert.deepEqual(findings, []);
});

test('current documentation contains no common encoding or private-path leaks', () => {
  const findings = [];
  for (const file of markdownFiles().filter(currentGuide)) {
    const content = fs.readFileSync(file, 'utf8');
    if (/Ã.|Â.|â(?:€|†|€™)|�/.test(content)) findings.push(`${relative(file)}: encoding`);
    if (/[A-Z]:\\Users\\(?!YOUR_USER|USERNAME|user\b)[^\\\s]+\\/i.test(content)) findings.push(`${relative(file)}: user path`);
    if (/github\.com\/oliver-hitchings\/scout-workspace/i.test(content)) findings.push(`${relative(file)}: private repository`);
  }
  assert.deepEqual(findings, []);
});

test('user-facing source files contain no common mojibake sequences', () => {
  const findings = [];
  for (const file of userFacingSourceFiles()) {
    if (commonMojibake.test(fs.readFileSync(file, 'utf8'))) findings.push(relative(file));
  }
  assert.deepEqual(findings, []);
});

test('maintainer instructions require operations context, documentation upkeep and privacy review', () => {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(content, /docs\/DOCUMENTATION\.md|Documentation maintenance/i, name);
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /Before any task, read `docs\/OPERATIONS\.md`/, name);
  }
  for (const name of ['templates/managed/AGENTS.md', 'templates/managed/CLAUDE.md']) {
    assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /Before any task, read `docs\/OPERATOR_CONTEXT\.md` when it exists/, name);
  }
  const operations = fs.readFileSync(path.join(root, 'docs', 'OPERATIONS.md'), 'utf8');
  for (const phrase of ['authoritative running host', '127.0.0.1:8459', '07:30 primary', '08:30 second pass', 'Pushing or merging a branch does not by itself update the live VPS', 'Maintenance contract']) {
    assert.match(operations, new RegExp(phrase, 'i'), phrase);
  }
  assert.doesNotMatch(operations, /tail\d+\.ts\.net|[A-Z]:\\Users\\/i);
  const policy = fs.readFileSync(path.join(root, 'docs', 'DOCUMENTATION.md'), 'utf8');
  assert.match(policy, /release notes, and in-app help text/i);
  assert.match(policy, /same pull request as the implementation/i);
  assert.match(policy, /private workspace data/i);
  assert.match(policy, /Do not create root-level TODO/i);
});

test('only the active Epic 77 audit ledger is retained with implementation plans', () => {
  const implementation = path.join(root, 'docs', 'implementation');
  const implementationMarkdown = fs.existsSync(implementation)
    ? fs.readdirSync(implementation).filter((name) => name.endsWith('.md')).sort()
    : [];
  assert.deepEqual(implementationMarkdown, ['epic-77-post-merge-audit-remediation.md']);

  const completedPlans = path.join(root, 'docs', 'superpowers', 'plans');
  const completedMarkdown = fs.existsSync(completedPlans)
    ? fs.readdirSync(completedPlans).filter((name) => name.endsWith('.md'))
    : [];
  assert.deepEqual(completedMarkdown, [], completedPlans);
});

test('beta.23 upgrade guidance explains the one-way fenced lease boundary', () => {
  const release = fs.readFileSync(path.join(root, 'docs', 'releases', '0.1.0-beta.23.md'), 'utf8');
  const upgrades = fs.readFileSync(path.join(root, 'docs', 'UPGRADES.md'), 'utf8');
  const troubleshooting = fs.readFileSync(path.join(root, 'docs', 'TROUBLESHOOTING.md'), 'utf8');

  for (const [name, content] of Object.entries({ release, upgrades, troubleshooting })) {
    assert.match(content, /old(?:er)? Scout.*(?:stop|stopped)|stop.*old(?:er)? Scout/is, `${name}: stop old Scout`);
    assert.match(content, /fenced lease.*authoritative|authoritative.*fenced lease/is, `${name}: authoritative lease`);
    assert.match(content, /downgrade.*coexist|coexist.*downgrade/is, `${name}: downgrade/coexistence refusal`);
  }
  assert.match(release, /no manual workspace-data conversion is normally needed/i);
});

test('beta.23 notes reconcile beta.22 through the candidate and readiness work 70 to 76', () => {
  const release = fs.readFileSync(path.join(root, 'docs', 'releases', '0.1.0-beta.23.md'), 'utf8');

  assert.match(release, /beta\.22.*candidate|candidate.*beta\.22/is);
  for (let issue = 70; issue <= 76; issue += 1) {
    assert.match(release, new RegExp(`#${issue}\\b`), `missing #${issue}`);
  }
  assert.match(release, /unknown location facts.*include.*penalise.*exclude/is);
  assert.match(release, /live.*(?:pending|not yet recorded)|(?:pending|not yet recorded).*live/is);
});

test('current guides explain the repaired beta.23 safety and review contracts', () => {
  const release = fs.readFileSync(path.join(root, 'docs', 'releases', '0.1.0-beta.23.md'), 'utf8');
  const quickStart = fs.readFileSync(path.join(root, 'docs', 'QUICK_START.md'), 'utf8');
  const providers = fs.readFileSync(path.join(root, 'docs', 'PROVIDERS.md'), 'utf8');
  const operations = fs.readFileSync(path.join(root, 'docs', 'OPERATIONS.md'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'docs', 'PRIVACY.md'), 'utf8');
  const supplyChain = fs.readFileSync(path.join(root, 'docs', 'SUPPLY_CHAIN_SECURITY.md'), 'utf8');

  assert.match(quickStart, /returned.*parsed.*new.*eligible.*selected.*promising/is);
  assert.match(quickStart, /rule value.*strength.*provenance/is);
  assert.match(providers, /sign-in.*blocks.*same provider.*other provider/is);
  assert.match(operations, /startup.*periodic.*backup.*fenced lease.*mutation coordinator/is);
  assert.match(operations, /torn.*queue.*quarantin/is);
  assert.match(privacy, /private.*redirect.*DNS|DNS.*private.*redirect/is);
  assert.match(release, /SSRF|server-side request forgery/i);
  assert.match(release, /orphaned.*Git|Git.*child.*successor/is);
  assert.match(release, /torn.*queue/i);
  assert.match(supplyChain, /full commit SHA|immutable commit SHA/i);
});

test('configuration distinguishes field influence and published-profile authority', () => {
  const configuration = fs.readFileSync(path.join(root, 'docs', 'CONFIGURATION.md'), 'utf8');

  for (const heading of [
    'Authoritative scan input',
    'Workspace runtime configuration',
    'Legacy compatibility inputs',
    'Deployment-only configuration',
    'Readiness and UI claims',
  ]) {
    assert.match(configuration, new RegExp(`^## ${heading}$`, 'm'), heading);
  }
  assert.match(configuration, /published search profile.*(?:creates|reconciles).*search-lanes\.json/is);
  assert.match(configuration, /query sources use only its selected active\s+lanes.*Legacy categories are not silently added/is);
  assert.match(configuration, /published search profile.*filtering.*ranking.*assessment/is);
  assert.match(configuration, /search\.roleFamilies.*legacy.*collection/is);
  assert.match(configuration, /search\.salaryMinimum.*legacy.*collection/is);
  assert.match(configuration, /profile\.displayName.*no scan-decision effect/is);
  assert.match(configuration, /setup\.completedAt.*does not change\s+collection, filtering, ranking or assessment/is);
  assert.match(configuration, /deployment-only.*not stored in `workspace\.json`/is);
  assert.match(configuration, /amountType.*base.*total.*rate.*unknown/is);
  assert.match(configuration, /certainty.*exact.*range.*estimated.*unknown/is);
  assert.match(configuration, /selection\.breadth.*relevanceThreshold.*exploration/is);
});

test('automation documents both non-overlapping two-provider presets', () => {
  const automation = fs.readFileSync(path.join(root, 'docs', 'AUTOMATION.md'), 'utf8');
  assert.match(automation, /Alternating with the other provider/);
  assert.match(automation, /Alternating weekdays \(no weekends\)/);
  assert.match(automation, /primary.*Monday, Wednesday and Friday/is);
  assert.match(automation, /verification.*Tuesday and Thursday/is);
});

test('current security and VPS guides describe the active release and remote-mutation contracts', () => {
  const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  const backup = fs.readFileSync(path.join(root, 'docs', 'VPS_BACKUP_AND_STATE.md'), 'utf8');
  assert.match(security, /GitHub\/Sigstore.*attestation/is);
  assert.match(security, /docs\/SUPPLY_CHAIN_SECURITY\.md/);
  assert.doesNotMatch(backup, /\bBeta 16\b/);
  assert.match(backup, /remote.*(?:mutation|state-changing request).*backup.*enabled/is);
});
