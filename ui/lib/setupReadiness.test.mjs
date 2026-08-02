import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { setupReadiness } from './setupReadiness.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture({ approved = false, history = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-ready-')); roots.push(root);
  const activatedFiles = [
    ['workspace.json', '{"synthetic":true}\n'],
    ['profile/context.md', 'x'.repeat(600)],
    ['profile/calibration.md', 'x'.repeat(150)],
    ['cv/master-cv.md', 'x'.repeat(600)],
    ['data/search-categories.json', '{"categories":[]}\n'],
  ];
  for (const [file, text] of activatedFiles) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text);
  }
  if (approved) {
    const activatedHashes = Object.fromEntries(activatedFiles.map(([file]) => [
      file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
    ]));
    fs.mkdirSync(path.join(root, '.scout/onboarding'), { recursive: true });
    fs.writeFileSync(path.join(root, '.scout/onboarding/activated.json'), JSON.stringify({ activatedHashes }));
  }
  return { root, tracker: { opportunities: history ? [{ id: 'legacy-role-2026-07' }] : [] } };
}
const config = { profile: { displayName: 'Sam' }, search: { roleFamilies: ['Software Engineer'], locations: ['Remote'], exclusions: [], salaryMinimum: null }, ai: { provider: 'codex' } };
const providers = { codex: { installed: true, authenticated: true } };
test('fresh setup requires explicit activation evidence', () => { const f = fixture(); assert.equal(setupReadiness(f.root, config, providers, f.tracker).ready, false); });
test('approved profession-neutral setup is ready with an empty tracker', () => { const f = fixture({ approved: true }); assert.equal(setupReadiness(f.root, config, providers, f.tracker).ready, true); });
test('established beta workspaces are grandfathered without resetting', () => { const f = fixture({ history: true }); const r = setupReadiness(f.root, config, providers, f.tracker); assert.equal(r.established, true); assert.equal(r.ready, true); });
test('missing provider authentication blocks readiness', () => { const f = fixture({ approved: true }); assert.equal(setupReadiness(f.root, config, { codex: { installed: true, authenticated: false } }, f.tracker).ready, false); });
test('authenticated provider with an outdated CLI blocks bounded setup', () => { const f = fixture({ approved: true }); assert.equal(setupReadiness(f.root, config, { codex: { installed: true, authenticated: true, capabilities: { structuredOutput: false } } }, f.tracker).ready, false); });
test('an activation marker cannot approve files that changed after activation', () => {
  const f = fixture({ approved: true });
  fs.appendFileSync(path.join(f.root, 'profile/context.md'), 'changed');
  assert.equal(setupReadiness(f.root, config, providers, f.tracker).ready, false);
});
