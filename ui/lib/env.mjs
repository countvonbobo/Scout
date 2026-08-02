import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { withWorkspaceMutationAuthority } from './workspaceMutationAuthority.mjs';

export function loadEnv(repoRoot) {
  const file = path.join(repoRoot, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export function saveEnv(repoRoot, values) {
  return withWorkspaceMutationAuthority(repoRoot, {
    kind: 'environment-save', phase: 'persist-environment',
  }, () => {
    const file = path.join(repoRoot, '.env');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
    const wanted = new Map(Object.entries(values).filter(([key]) => /^[A-Z][A-Z0-9_]*$/.test(key)));
    const out = [];
    for (const line of existing) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!match || !wanted.has(match[1])) { if (line) out.push(line); continue; }
      const value = String(wanted.get(match[1]) || '').replace(/[\r\n]/g, '');
      out.push(`${match[1]}=${value}`);
      wanted.delete(match[1]);
    }
    for (const [key, raw] of wanted) out.push(`${key}=${String(raw || '').replace(/[\r\n]/g, '')}`);
    atomicWriteFile(file, `${out.join('\n')}\n`, { mode: 0o600 });
  });
}
