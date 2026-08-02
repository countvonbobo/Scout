import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ACTIVATED_FILES = [
  'workspace.json', 'profile/context.md', 'profile/calibration.md',
  'cv/master-cv.md', 'data/search-categories.json',
];

function meaningful(file, minimumBytes) {
  return fs.existsSync(file) && fs.statSync(file).size >= minimumBytes;
}

function activatedApproval(root) {
  const file = path.join(root, '.scout', 'onboarding', 'activated.json');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  try {
    return ACTIVATED_FILES.every((relative) => {
      const target = path.join(root, ...relative.split('/'));
      const expected = marker?.activatedHashes?.[relative];
      return typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected)
        && fs.existsSync(target)
        && fs.lstatSync(target).isFile()
        && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === expected;
    });
  } catch {
    return false;
  }
}

export function setupReadiness(root, config, providers, tracker) {
  const opportunities = Array.isArray(tracker?.opportunities) ? tracker.opportunities : [];
  const provider = config.ai?.provider;
  const providerReady = Boolean(provider && providers?.[provider]?.installed && providers?.[provider]?.authenticated
    && providers?.[provider]?.capabilities?.structuredOutput !== false);
  const preferencesReady = Boolean(
    config.profile?.displayName
    && config.search?.roleFamilies?.length
    && config.search?.locations?.length
    && Array.isArray(config.search?.exclusions)
    && Object.hasOwn(config.search || {}, 'salaryMinimum')
  );
  const evidenceReady = meaningful(path.join(root, 'profile', 'context.md'), 150)
    && meaningful(path.join(root, 'profile', 'calibration.md'), 100)
    && meaningful(path.join(root, 'cv', 'master-cv.md'), 500);
  const approved = activatedApproval(root) || (opportunities.length > 0 && evidenceReady);
  const checks = { provider: providerReady, preferences: preferencesReady, evidence: evidenceReady, approved, tracker: Boolean(tracker) };
  return { checks, established: opportunities.length > 0 && evidenceReady, ready: Object.values(checks).every(Boolean) };
}
