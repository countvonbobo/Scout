import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advertMateriallyChanged, canonicalJobUrl, invalidateJobIdentity, jobIdentity, sameUnderlyingJob,
} from './jobIdentity.mjs';

test('canonical URLs ignore fragments and common tracking parameters', () => {
  assert.equal(canonicalJobUrl('https://EXAMPLE.test/jobs/1/?utm_source=x&ref=mail#apply'), 'https://example.test/jobs/1');
});

test('cross-provider copies of one role match by normalised evidence', () => {
  const first = { company: 'Acme Ltd', title: 'Senior Platform Engineer', location: 'London, UK', source: 'adzuna', providerId: 'a1', url: 'https://a.test/1', description: 'Build reliable Kubernetes services with AWS observability and mentor engineers.' };
  const second = { company: 'Acme', role: 'Senior Platform Engineer', location: 'London', source: 'ats-greenhouse', providerId: 'g9', url: 'https://g.test/9', description: 'Mentor engineers and build reliable Kubernetes services with AWS observability.' };
  assert.equal(sameUnderlyingJob(first, second), true);
});

test('different provider IDs from one source protect distinct openings', () => {
  const common = { company: 'Acme', title: 'Software Engineer', location: 'London', source: 'ats-greenhouse', description: 'Build the same platform services.' };
  assert.equal(sameUnderlyingJob({ ...common, providerId: '1', url: 'https://x.test/1' }, { ...common, providerId: '2', url: 'https://x.test/2' }), false);
});

test('different IDs from one provider stay distinct even when their canonical URLs match', () => {
  const common = { company: 'Acme', title: 'Software Engineer', location: 'London', source: 'ats-greenhouse', url: 'https://careers.acme.test/jobs/engineer', description: 'Build the same platform services.' };
  assert.equal(sameUnderlyingJob({ ...common, providerId: '1' }, { ...common, providerId: '2' }), false);
});

test('different locations and seniority remain separate', () => {
  const common = { company: 'Acme', source: 'adzuna', description: 'Build embedded control systems for production hardware.' };
  assert.equal(sameUnderlyingJob({ ...common, title: 'Senior Engineer', location: 'London' }, { ...common, title: 'Staff Engineer', location: 'London' }), false);
  assert.equal(sameUnderlyingJob({ ...common, title: 'Senior Engineer', location: 'London' }, { ...common, title: 'Senior Engineer', location: 'Edinburgh' }), false);
});

test('material advert changes are distinguished from wording changes', () => {
  const base = { company: 'Acme', title: 'Engineer', description: 'Design embedded electronics PCB hardware testing production verification firmware sensors.' };
  assert.equal(advertMateriallyChanged(base, { ...base, description: 'Design embedded electronics and PCB hardware, including testing, production verification, firmware and sensors.' }), false);
  assert.equal(advertMateriallyChanged(base, { ...base, description: 'Lead enterprise sales accounts pipeline forecasting negotiation contracts revenue customer acquisition.' }), true);
});

test('job identities are cached until a deliberate candidate merge invalidates them', () => {
  const job = { company: 'Acme', role: 'Engineer', description: 'Build the first version with embedded systems expertise.' };
  const first = jobIdentity(job);
  assert.equal(jobIdentity(job), first);
  job.description = 'Lead an entirely different production platform and safety programme.';
  assert.equal(jobIdentity(job), first);
  invalidateJobIdentity(job);
  assert.notEqual(jobIdentity(job), first);
});
