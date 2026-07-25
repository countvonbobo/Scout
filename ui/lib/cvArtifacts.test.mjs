import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactSlugFor, resolveArtifact, artifactOwners } from './cvArtifacts.mjs';

const slugOfCompany = (c) => String(c || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

test('artifact slug uses the stable opportunity id', () => {
  assert.equal(artifactSlugFor({ id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' }), 'acme-backend-engineer-2026-07');
});

test('artifact slug falls back to company-role when the id is not slug-shaped', () => {
  assert.equal(artifactSlugFor({ id: 'Acme/Eng 2026', company: 'Acme & Co', role: 'Backend Engineer' }), 'acme-and-co-backend-engineer');
});

test('an existing id-keyed directory is preferred', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  assert.deepEqual(resolveArtifact(['acme-backend-engineer-2026-07', 'acme'], o, slugOfCompany), { slug: 'acme-backend-engineer-2026-07', legacy: false, ambiguous: false });
});

test('a legacy company directory is reused and flagged', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  assert.deepEqual(resolveArtifact(['acme'], o, slugOfCompany), { slug: 'acme', legacy: true, ambiguous: false });
});

test('a legacy directory shared by two roles is ambiguous', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  const owners = artifactOwners(['acme'], [o, { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' }], slugOfCompany);
  assert.deepEqual(owners.get('acme'), ['acme-backend-engineer-2026-07', 'acme-frontend-engineer-2026-07']);
  assert.equal(resolveArtifact(['acme'], o, slugOfCompany, [o, { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' }]).ambiguous, true);
});

test('with no existing directory a fresh id-keyed slug is returned', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  assert.deepEqual(resolveArtifact([], o, slugOfCompany), { slug: 'acme-backend-engineer-2026-07', legacy: false, ambiguous: false });
});
