import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { withWorkspaceMutationAuthority } from './workspaceMutationAuthority.mjs';
import { companyId, normalizeCompanyTimeline } from './companyTimeline.mjs';

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

export function companyTimelinePath(repoRoot, companyOrId) {
  const id = SAFE_ID.test(String(companyOrId || '')) ? String(companyOrId) : companyId(companyOrId);
  if (!SAFE_ID.test(id)) throw new Error(`invalid company id: ${id}`);
  return path.join(repoRoot, 'data', 'companies', `${id}.json`);
}

export function loadCompanyTimeline(repoRoot, company) {
  const file = companyTimelinePath(repoRoot, company);
  if (!fs.existsSync(file)) return normalizeCompanyTimeline(null, company);
  return normalizeCompanyTimeline(JSON.parse(fs.readFileSync(file, 'utf8')), company);
}

export function saveCompanyTimeline(repoRoot, company, record) {
  const file = companyTimelinePath(repoRoot, company);
  return withWorkspaceMutationAuthority(repoRoot, {
    kind: 'company-save', phase: 'persist-company',
  }, () => {
    atomicWriteFile(file, `${JSON.stringify(normalizeCompanyTimeline(record, company), null, 2)}\n`);
    return file;
  });
}
