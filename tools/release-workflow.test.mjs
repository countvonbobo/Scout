import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const workspaceRepair = fs.readFileSync(new URL('../.github/workflows/vps-workspace-repair.yml', import.meta.url), 'utf8');
const deploy = fs.readFileSync(new URL('./deploy-vps.sh', import.meta.url), 'utf8');
const supplyChain = fs.readFileSync(new URL('../docs/SUPPLY_CHAIN_SECURITY.md', import.meta.url), 'utf8');

test('tagged release workflow validates version and requires private markers', () => {
  assert.match(workflow, /Tag does not match package version/);
  assert.match(workflow, /--require-markers/);
  assert.match(workflow, /SCOUT_RELEASE_MARKERS/);
});

test('CI audits fork pull requests without exposing private release markers', () => {
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.match(ci, /Audit staged public tree for fork pull requests[\s\S]*if: github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository[\s\S]*--root dist\/release\/stage --stage\s/);
  assert.match(ci, /Audit staged public tree with required private markers[\s\S]*if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository[\s\S]*--require-markers[\s\S]*SCOUT_RELEASE_MARKERS: \$\{\{ secrets\.SCOUT_RELEASE_MARKERS \}\}/);
});

test('release publication has scoped write permission and publishes checksum', () => {
  assert.match(workflow, /publish:[\s\S]*permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /checksums\.txt/);
  const globalWrite = workflow.match(/^permissions:\s*\n\s*contents: write/m);
  assert.equal(globalWrite, null);
});

test('tagged releases keylessly attest and verify every checksum subject before publication', () => {
  assert.match(workflow, /publish:[\s\S]*permissions:[\s\S]*id-token: write/);
  assert.match(workflow, /publish:[\s\S]*permissions:[\s\S]*attestations: write/);
  assert.match(workflow, /uses: actions\/attest@v4[\s\S]*subject-checksums: release-assets\/checksums\.txt/);
  assert.match(workflow, /steps\.attest\.outputs\.bundle-path/);
  assert.match(workflow, /checksums\.intoto\.jsonl/);
  assert.match(workflow, /gh attestation verify/);
  assert.doesNotMatch(workflow, /COSIGN_(?:PRIVATE_KEY|PASSWORD)/);
});

test('release documentation defines checksum, keyless identity and platform-signing boundaries', () => {
  assert.match(supplyChain, /checksums\.intoto\.jsonl/);
  assert.match(supplyChain, /gh attestation verify/);
  assert.match(supplyChain, /--custom-trusted-root/);
  assert.match(supplyChain, /GitHub OIDC/);
  assert.match(supplyChain, /no long-lived (?:project )?signing key/i);
  assert.match(supplyChain, /rotation/i);
  assert.match(supplyChain, /revocation|compromised release/i);
  assert.match(supplyChain, /Authenticode/);
  assert.match(supplyChain, /Developer ID/);
  assert.match(supplyChain, /checksums? verify bytes.*not.*publisher identity/is);
  assert.match(supplyChain, /Scout-<version>-macos-<architecture>\.dmg/);
  assert.doesNotMatch(supplyChain, /Developer ID Installer/);
});

test('release workflow builds and smoke tests every supported platform', () => {
  assert.match(workflow, /windows-2022/); assert.match(workflow, /macos-15-intel/); assert.match(workflow, /macos-15/); assert.match(workflow, /ubuntu-22\.04/);
  assert.match(workflow, /build-platform\.mjs mac/); assert.match(workflow, /build-platform\.mjs linux/); assert.match(workflow, /preserve workspace/i);
});

test('tagged release deploys the private VPS before publication', () => {
  assert.match(workflow, /deploy-vps:[\s\S]*environment: beta-vps/);
  assert.match(workflow, /tailscale\/github-action@v4/);
  assert.match(workflow, /oauth-secret: \$\{\{ secrets\.TS_OAUTH_SECRET \}\}/);
  assert.match(workflow, /tags: tag:scout-deploy/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /inputs\.deploy_vps/);
  assert.match(workflow, /inputs\.test_rollback/);
  assert.match(workflow, /--connect-timeout 5 --max-time 10/);
  assert.match(workflow, /status" != 000 && "\$status" != 403/);
  assert.match(workflow, /deployment tag must be denied by the tailnet or Scout/i);
  assert.match(workflow, /scout-deploy@"\$VPS_HOST"/);
  assert.doesNotMatch(workflow, /ubuntu@"\$VPS_HOST"/);
  assert.match(workflow, /publish:[\s\S]*needs: \[windows, macos, linux, deploy-vps\]/);
  assert.match(deploy, /status --porcelain --untracked-files=normal -- \. ':\(exclude\)\.scout-runtime\/\*\*'/);
  assert.match(deploy, /refs\/tags\/v\$version:refs\/tags\/v\$version/);
  assert.match(deploy, /refs\/heads\/codex\/release-candidate/);
  assert.match(deploy, /npm ci --omit=dev[\s\S]*npm test/);
  assert.match(deploy, /npm ci[\s\S]*npm test[\s\S]*systemctl restart/);
  assert.match(deploy, /127\.0\.0\.1:8459\/api\/app-info/);
  assert.match(deploy, /cmp --silent "\$serve_before" "\$serve_after"/);
  assert.match(deploy, /remote preflight --require-serve-mapping/);
  assert.match(deploy, /127\.0\.0\.1:8459\/api\/cv/);
  assert.match(deploy, /Array\.isArray\(index\.entries\)/);
  assert.match(deploy, /entry\?\.source === true/);
  assert.match(deploy, /SCOUT_VPS_DEPLOY_USER:-scout-deploy/);
  assert.match(deploy, /SCOUT_VPS_SERVICE_USER:-ubuntu/);
  assert.match(deploy, /property=ExecStart/);
  assert.match(deploy, /export PATH="\$\(dirname "\$service_node"\):\$PATH"/);
  assert.match(deploy, /Controlled rehearsal failure requested/);
  assert.match(deploy, /Rollback restored Scout/);
  assert.doesNotMatch(deploy, /tailscale serve (?:reset|--bg|--https)/);
  assert.doesNotMatch(deploy, /Documents\/Scout Workspace.*(?:rm|git|npm)/);
});

test('VPS deployment script has valid Bash syntax', { skip: process.platform === 'win32' && 'Bash is checked on Linux and macOS release runners' }, () => {
  const result = spawnSync('bash', ['-n', fileURLToPath(new URL('./deploy-vps.sh', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('VPS dirty check permits only Scout managed Typst files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-deploy-status-'));
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    assert.equal(git('init').status, 0);
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    assert.equal(git('add', 'package.json').status, 0);
    assert.equal(git('-c', 'user.name=Scout Test', '-c', 'user.email=scout@example.invalid', 'commit', '-m', 'seed').status, 0);
    fs.mkdirSync(path.join(root, '.scout-runtime'));
    fs.writeFileSync(path.join(root, '.scout-runtime', 'typst'), 'managed');
    const status = () => git('status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude).scout-runtime/**').stdout;
    assert.equal(status(), '');
    fs.writeFileSync(path.join(root, 'unexpected.txt'), 'private');
    assert.match(status(), /unexpected\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace repair is protected, local-only and verifies backup plus rendered CVs', () => {
  assert.match(workspaceRepair, /environment: beta-vps/);
  assert.match(workspaceRepair, /concurrency:[\s\S]*group: scout-beta-vps/);
  assert.match(workspaceRepair, /tailscale\/github-action@v4/);
  assert.match(workspaceRepair, /StrictHostKeyChecking=yes/);
  assert.match(workspaceRepair, /127\.0\.0\.1:8459\/api\/sync\/deploy-key/);
  assert.match(workspaceRepair, /127\.0\.0\.1:8459\/api\/workspace\/adopt-private/);
  assert.match(workspaceRepair, /rotate-and-verify/);
  assert.match(workspaceRepair, /127\.0\.0\.1:8459\/api\/sync\/passphrase/);
  assert.match(workspaceRepair, /SCOUT_WORKSPACE_PASSPHRASE/);
  assert.match(workspaceRepair, /expected_cv_sources/);
  assert.match(workspaceRepair, /api\/cv\/render/);
  assert.match(workspaceRepair, /api\/sync\/status/);
  assert.doesNotMatch(workspaceRepair, /echo .*PASSPHRASE/);
});

test('package, installer and release notes use one beta version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  assert.match(installer, new RegExp(`MyAppVersion "${pkg.version.replaceAll('.', '\\.')}"`));
  assert.equal(fs.existsSync(new URL(`../docs/releases/${pkg.version}.md`, import.meta.url)), true);
});

test('Windows setup uses the tracked Scout icon', () => {
  const installer = fs.readFileSync(new URL('../installer/Scout.iss', import.meta.url), 'utf8');
  assert.match(installer, /SetupIconFile=\.\.\\ui\\assets\\scout-icon\.ico/);
  assert.equal(fs.existsSync(new URL('../ui/assets/scout-icon.ico', import.meta.url)), true);
});
