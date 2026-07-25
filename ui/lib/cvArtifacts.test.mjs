import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactSlugFor, chooseArtifactSlug, resolveArtifact, artifactOwners } from './cvArtifacts.mjs';

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

test('chooseArtifactSlug honours a user decision the resolver could itself produce', () => {
  const backend = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  const frontend = { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' };
  const all = [backend, frontend];
  // "Open it as-is": the legacy folder the resolver already resolved to.
  assert.equal(chooseArtifactSlug(['acme'], frontend, slugOfCompany, all, 'acme'), 'acme');
  // "Start fresh": the per-role folder, even though a legacy folder exists.
  assert.equal(chooseArtifactSlug(['acme'], frontend, slugOfCompany, all, 'acme-frontend-engineer-2026-07'),
    'acme-frontend-engineer-2026-07');
  // No request at all falls back to the plain resolution.
  assert.equal(chooseArtifactSlug(['acme'], frontend, slugOfCompany, all), 'acme');
  assert.equal(chooseArtifactSlug([], frontend, slugOfCompany, all), 'acme-frontend-engineer-2026-07');
});

test('chooseArtifactSlug rejects a slug this opportunity could never resolve to', () => {
  const frontend = { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' };
  const existing = ['acme', 'acme-backend-engineer-2026-07'];
  // Another role's folder is not a slug the resolver would produce for this
  // opportunity, so it can never become a write target.
  assert.equal(chooseArtifactSlug(existing, frontend, slugOfCompany, [frontend], 'acme-backend-engineer-2026-07'), 'acme');
  assert.equal(chooseArtifactSlug(existing, frontend, slugOfCompany, [frontend], '../../etc'), 'acme');
  assert.equal(chooseArtifactSlug(existing, frontend, slugOfCompany, [frontend], '   '), 'acme');
});
