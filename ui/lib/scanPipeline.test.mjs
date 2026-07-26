import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyHardExclusions, compactCandidates, DEFAULT_CANDIDATE_LIMIT, gateAssessment, inboxRecheckCandidates, promptCandidate,
  filterVacancies, validateAssessments, validateWrittenScanArtifacts, verificationCandidates, writeScanArtifacts,
} from './scanPipeline.mjs';

const dimensions = [{ name: 'Fit', score: 90, maximum: 100, evidence: 'Advert and profile' }];
const assessment = (status = 'met') => ({
  candidateId: 'candidate-001', categoryId: 'software', summary: 'Synthetic fit', hardExclusionMatches: [],
  mandatoryRequirements: [{ requirement: 'AWS', advertEvidence: 'AWS is required', advertEvidenceId: 'provider-aws', status, profileEvidence: status === 'met' ? 'Built systems on AWS' : null }],
  dimensions, recommendation: 'keep',
});

test('candidate input is deduplicated, capped and descriptions are bounded', () => {
  const job = { company: 'Acme', title: 'Engineer', url: 'https://example.test/job', description: 'x'.repeat(2000) };
  const { candidates: result } = compactCandidates({ one: { jobs: [job, job] } }, 40);
  assert.equal(result.length, 1);
  assert.equal(result[0].description.length, 1200);
});

test('the assessment boundary receives only structured-filter eligible vacancies', () => {
  const candidate = { vacancyId: 'vacancy-001', title: { value: 'Software Engineer', provenance: 'explicit-source' }, description: 'Perform coding.' };
  const profile = {
    id: 'profile-filter0001', version: 1,
    target: {}, negative: { excludedResponsibilities: [{ value: 'coding', strength: 'hard-exclusion', provenance: 'confirmed-inference' }] },
    compensation: { unknownPolicy: 'include', minimum: null },
  };
  const result = filterVacancies([candidate], profile);
  assert.equal(result.eligible.length, 0);
  assert.equal(result.excluded[0].code, 'excluded-responsibility');
});

test('candidate input collapses the same cross-provider role and preserves every source', () => {
  const description = 'Build reliable Kubernetes services with AWS observability and mentor engineers.';
  const { candidates: result } = compactCandidates({
    one: { jobs: [{ company: 'Acme Ltd', title: 'Senior Platform Engineer', location: 'London, UK', url: 'https://a.test/1?utm_source=feed', source: 'adzuna', providerId: 'a1', description }] },
    two: { jobs: [{ company: 'Acme', title: 'Senior Platform Engineer', location: 'London', url: 'https://g.test/9', source: 'ats-greenhouse', providerId: 'g9', description }] },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].duplicateCount, 2);
  assert.deepEqual(result[0].sources, ['https://a.test/1', 'https://g.test/9']);
});

test('candidate input keeps similar but distinct openings separate', () => {
  const common = { company: 'Acme', location: 'London', source: 'ats-greenhouse', description: 'Build reliable platform services.' };
  const { candidates: result } = compactCandidates({ one: { jobs: [
    { ...common, title: 'Software Engineer', providerId: 'one', url: 'https://x.test/1' },
    { ...common, title: 'Software Engineer', providerId: 'two', url: 'https://x.test/2' },
    { ...common, title: 'Staff Software Engineer', providerId: 'three', url: 'https://x.test/3' },
  ] } });
  assert.equal(result.length, 3);
});

test('mandatory advert language is assigned stable signals that assessments cannot omit', () => {
  const { candidates } = compactCandidates({ one: { jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job', description: 'AWS is required. Mentoring is helpful.' }] } });
  assert.deepEqual(candidates[0].mandatorySignals, [{ id: 'mandatory-01', text: 'AWS is required' }]);
  assert.throws(() => validateAssessments({ assessments: [assessment('met')] }, candidates), /omitted mandatory advert evidence/);
  const covered = assessment('unknown');
  covered.mandatoryRequirements[0].advertEvidenceId = 'mandatory-01';
  assert.equal(validateAssessments({ assessments: [covered] }, candidates).assessments.length, 1);
});

test('normalized source requirement summaries are mandatory without keyword heuristics', () => {
  const { candidates } = compactCandidates({ one: { jobs: [{
    company: 'Example', title: 'Senior Rust Engineer', url: 'https://example.test/rust',
    description: 'Build cross-platform libraries.',
    requirements: 'Rust software engineer with cross-platform experience; fluent in English; eligible for stock options',
  }] } });
  assert.deepEqual(candidates[0].mandatorySignals, [
    { id: 'mandatory-01', text: 'Rust software engineer with cross-platform experience' },
    { id: 'mandatory-02', text: 'fluent in English' },
  ]);
  const missingRust = {
    ...assessment('unknown'), candidateId: candidates[0].candidateId,
    mandatoryRequirements: [
      { requirement: 'Rust and cross-platform experience', advertEvidence: candidates[0].mandatorySignals[0].text, advertEvidenceId: 'mandatory-01', status: 'unknown', profileEvidence: null },
      { requirement: 'English', advertEvidence: candidates[0].mandatorySignals[1].text, advertEvidenceId: 'mandatory-02', status: 'met', profileEvidence: 'English CV evidence' },
    ],
  };
  assert.equal(validateAssessments({ assessments: [missingRust] }, candidates).assessments.length, 1);
  assert.equal(gateAssessment(missingRust, { actionScore: 70, checkScore: 55 }).score, 69);
  assert.equal(gateAssessment(missingRust, { actionScore: 70, checkScore: 55 }).eligibility, 'check');
});

test('mandatory and exclusion gates recompute trusted scores and bands', () => {
  assert.deepEqual(gateAssessment(assessment('unmet'), { actionScore: 70, checkScore: 55 }), {
    eligibility: 'ineligible', score: 54, keep: false, reasons: ['AWS'],
  });
  assert.deepEqual(gateAssessment(assessment('unknown'), { actionScore: 70, checkScore: 55 }), {
    eligibility: 'check', score: 69, keep: true, reasons: ['AWS'],
  });
  const excluded = assessment('met');
  excluded.hardExclusionMatches = ['gambling'];
  assert.equal(gateAssessment(excluded, { actionScore: 70, checkScore: 55 }).keep, false);
  assert.throws(() => validateAssessments({ assessments: [{ ...assessment('met'), dimensions: [{ ...dimensions[0], score: 101 }] }] }, [{ candidateId: 'candidate-001' }]), /invalid score/);
  assert.throws(() => validateAssessments({ assessments: [] }, [{ candidateId: 'candidate-001' }]), /covered 0 of 1/);
});

test('runtime writes canonical scan records and preserves user tracker state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-scan-pipeline-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const existing = { updated: '2026-07-01', opportunities: [{
    id: 'acme-engineer-2026-07', company: 'Acme', role: 'Engineer', score: 60, status: 'watch',
    sources: ['https://example.test/job'], tags: ['user-tag'], notes: 'user note', contacts: [{ name: 'Synthetic' }], log: [{ date: '2026-07-01', event: 'replied', note: '' }],
  }] };
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify(existing)}\n`);
  const candidates = [{ candidateId: 'candidate-001', company: 'Acme', role: 'Engineer', url: 'https://example.test/job', source: 'hiring_cafe' }];
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', queries: ['engineer'], startedAt: '2026-07-14T10:00:00Z', candidates,
    sources: { hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [] } },
    assessmentResult: { assessments: [assessment('met')] }, policy: { actionScore: 70, checkScore: 55 },
  });
  assert.equal(artifacts.run.schemaVersion, 3);
  assert.deepEqual(artifacts.run.sources_checked, ['hiring_cafe']);
  assert.deepEqual(artifacts.run.queries_checked, ['engineer']);
  assert.equal(artifacts.run.candidates_found, 1);
  assert.equal(artifacts.run.duplicates_collapsed, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8')).opportunities[0];
  assert.equal(saved.status, 'watch');
  assert.equal(saved.notes, 'user note');
  assert.deepEqual(saved.contacts, [{ name: 'Synthetic' }]);
  assert.deepEqual(saved.log, [{ date: '2026-07-01', event: 'replied', note: '' }]);
  assert.equal(saved.eligibility.status, 'eligible');
  assert.equal(validateWrittenScanArtifacts(root, artifacts.run).run.agent, 'codex');
});

test('forty zero-keeper candidates produce a bounded sanitised audit without tracker padding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-zero-keeper-audit-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    company: `Synthetic Company ${index + 1}`, role: `Synthetic Role ${index + 1}`,
    url: `https://example.test/jobs/${index + 1}`, source: 'synthetic',
    description: 'This full advert text must not be retained in the audit.',
  }));
  const assessments = candidates.map((candidate, index) => ({
    ...assessment(index < 16 ? 'unmet' : 'met'), candidateId: candidate.candidateId,
    recommendation: index < 16 ? 'keep' : 'discard', summary: `Concise synthetic reason ${index + 1}`,
  }));
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { synthetic: { configured: true, status: 'healthy', count: 40 } },
    candidates, assessmentResult: { assessments }, policy: { actionScore: 70, checkScore: 55 },
    startedAt: '2026-07-14T10:00:00Z',
  });
  assert.equal(artifacts.tracker.opportunities.length, 0);
  assert.deepEqual(artifacts.run.discarded, { hard_exclusion: 0, mandatory_unmet: 16, below_threshold: 0, provider_discarded: 24, advert_closed: 0 });
  assert.equal(artifacts.run.reviewed.length, 40);
  assert.deepEqual(Object.keys(artifacts.run.reviewed[0]).sort(), ['categoryId', 'company', 'outcome', 'reasons', 'role', 'score', 'source', 'sourceUrl'].sort());
  assert.doesNotMatch(JSON.stringify(artifacts.run.reviewed), /full advert|profileEvidence|Built systems/);
});

test('two same-day providers remain visible in one combined report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-combined-report-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const input = {
    sources: { ats: { configured: true, status: 'healthy', count: 0 } },
    candidates: [], assessmentResult: { assessments: [] }, policy: {}, startedAt: new Date().toISOString(),
  };
  writeScanArtifacts(root, { ...input, provider: 'claude', mode: 'primary' });
  const second = writeScanArtifacts(root, { ...input, provider: 'codex', mode: 'second-pass' });
  const report = fs.readFileSync(second.report, 'utf8');
  assert.match(report, /## Scan runs/);
  assert.match(report, /claude primary/);
  assert.match(report, /codex second-pass/);
});

test('later cross-provider reposts update one opportunity without losing user-owned state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-dedupe-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const description = 'Build reliable Kubernetes services with AWS observability and mentor engineers across production systems.';
  const existing = { updated: '2026-06-01', opportunities: [{
    id: 'acme-senior-platform-engineer-2026-06', company: 'Acme Ltd', role: 'Senior Platform Engineer', location: 'London, UK',
    status: 'interview', notes: 'Keep this note', application: { stages: [{ name: 'Interview' }] },
    sources: ['https://a.test/old'], sourceReferences: [{ source: 'adzuna', providerId: 'a1', url: 'https://a.test/old' }],
    jobIdentity: { company: 'acme', title: 'senior platform engineer', location: 'london uk', advertFingerprint: description },
    tags: [], contacts: [], log: [],
  }] };
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify(existing)}\n`);
  const { candidates } = compactCandidates({ ats: { jobs: [{
    company: 'Acme', title: 'Senior Platform Engineer', location: 'London', source: 'ats-greenhouse', providerId: 'g9',
    url: 'https://g.test/new', description,
  }] } });
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { ats: { configured: true, status: 'healthy', count: 1 } },
    candidates, assessmentResult: { assessments: [assessment('met')] }, policy: { actionScore: 70, checkScore: 55 },
    startedAt: '2026-08-01T10:00:00Z',
  });
  assert.equal(artifacts.tracker.opportunities.length, 1);
  assert.equal(artifacts.run.keepers_added, 0);
  assert.equal(artifacts.run.keepers_updated, 1);
  const saved = artifacts.tracker.opportunities[0];
  assert.equal(saved.id, 'acme-senior-platform-engineer-2026-06');
  assert.equal(saved.status, 'interview');
  assert.equal(saved.notes, 'Keep this note');
  assert.deepEqual(saved.application, { stages: [{ name: 'Interview' }] });
  assert.deepEqual(saved.sources, ['https://a.test/old', 'https://g.test/new']);
});

test('zero configured sources is degraded and still produces a truthful empty run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-empty-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { hiring_cafe: { configured: false, status: 'unavailable', count: 0 } },
    queries: [], candidates: [], assessmentResult: null, policy: {}, startedAt: '2026-07-14T10:00:00Z',
  });
  assert.equal(artifacts.run.degraded, true);
  assert.deepEqual(artifacts.run.errors, ['no job sources are configured']);
  assert.equal(artifacts.run.candidates_found, 0);
});

test('trusted runtime applies configured hard exclusions even when provider omits them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-exclusion-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const candidates = [{ candidateId: 'candidate-001', company: 'BetCo', role: 'Engineer', url: 'https://example.test/job', source: 'ats', description: 'Gambling platform' }];
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { ats: { configured: true, status: 'healthy', count: 1 } },
    candidates, assessmentResult: { assessments: [assessment('met')] }, policy: { actionScore: 70, checkScore: 55 },
    exclusions: ['gambling'], startedAt: '2026-07-14T10:00:00Z',
  });
  assert.equal(artifacts.tracker.opportunities.length, 0);
  assert.equal(artifacts.run.discarded.hard_exclusion, 1);
});

// Distinct company names, so the identity rules treat these as separate jobs.
const WORDS = ['Alder', 'Birch', 'Cedar', 'Dahlia', 'Elm', 'Fern', 'Ginkgo', 'Hazel', 'Iris', 'Juniper'];
const uniqueName = (prefix, index) => `${prefix}-${WORDS[index % WORDS.length]}${Math.floor(index / WORDS.length)}`;
const jobsFor = (prefix, count) => Array.from({ length: count }, (_, index) => ({
  company: `${uniqueName(prefix, index)} Holdings`, title: `${uniqueName(prefix, index)} Platform Engineer`,
  url: `https://${prefix}.test/jobs/${index}`, source: prefix, providerId: `${prefix}-${index}`,
  description: `Build ${uniqueName(prefix, index)} systems.`,
}));

test('one oversized source cannot starve the others', () => {
  const { candidates, dropped } = compactCandidates({
    ats: { jobs: jobsFor('ats', 200) },
    hiring_cafe: { jobs: jobsFor('cafe', 30) },
    adzuna: { jobs: jobsFor('adzuna', 30) },
  }, 60);
  assert.equal(candidates.length, 60);
  const bySource = {};
  for (const candidate of candidates) bySource[candidate.source] = (bySource[candidate.source] || 0) + 1;
  // Every configured source must reach the assessment, which the previous
  // source-ordered fill made impossible once the cap was reached.
  assert.deepEqual(Object.keys(bySource).sort(), ['adzuna', 'ats', 'cafe']);
  for (const source of ['adzuna', 'ats', 'cafe']) assert.ok(bySource[source] >= 20, `${source} received ${bySource[source]}`);
  // Truncation is reported rather than silent, per source.
  assert.equal(dropped.perSource.ats, 200 - bySource.ats);
  assert.equal(dropped.perSource.hiring_cafe, 30 - bySource.cafe);
  assert.equal(dropped.perSource.adzuna, 30 - bySource.adzuna);
  assert.equal(dropped.total, 260 - 60);
});

test('a scan that fits reports nothing dropped and keeps stable candidate ids', () => {
  const { candidates, dropped } = compactCandidates({ ats: { jobs: jobsFor('ats', 5) } }, DEFAULT_CANDIDATE_LIMIT);
  assert.equal(candidates.length, 5);
  assert.deepEqual(dropped, { perSource: {}, total: 0 });
  assert.deepEqual(candidates.map((candidate) => candidate.candidateId), [
    'candidate-001', 'candidate-002', 'candidate-003', 'candidate-004', 'candidate-005',
  ]);
});

test('hard exclusions are applied before any provider turn', () => {
  const { candidates } = compactCandidates({ one: { jobs: [
    { company: 'Acme', title: 'Engineer', url: 'https://x.test/1', description: 'Extensive travel is required.' },
    { company: 'Beta', title: 'Engineer', url: 'https://x.test/2', description: 'Fully remote role.' },
    { company: 'Gamma', title: 'Gambling Product Engineer', url: 'https://x.test/3', description: 'Casino products.' },
  ] } });
  const result = applyHardExclusions(candidates, ['extensive travel', 'gambling']);
  assert.deepEqual(result.kept.map((item) => item.company), ['Beta']);
  assert.deepEqual(result.excluded.map((item) => item.hardExclusionMatches), [['extensive travel'], ['gambling']]);
  assert.equal(applyHardExclusions(candidates, []).kept.length, candidates.length);
  assert.equal(applyHardExclusions(candidates, ['', '   ']).kept.length, candidates.length);
  // Tags are deliberately not searched: the post-assessment trusted pass looks
  // only at company, role and description, and the two must agree.
  const tagged = [{ company: 'Acme', role: 'Engineer', description: 'Remote role.', tags: ['gambling'] }];
  assert.equal(applyHardExclusions(tagged, ['gambling']).kept.length, 1);
});

test('the prompt payload drops fields the model never reads', () => {
  const { candidates } = compactCandidates({ one: { jobs: [{
    company: 'Acme', title: 'Engineer', url: 'https://x.test/1', providerId: 'p1',
    description: 'Rust is required.', requirements: 'Rust; English',
  }] } });
  const payload = promptCandidate(candidates[0]);
  for (const field of ['requirements', 'sourceReferences', 'providerId', 'duplicateCount', 'sources']) {
    assert.equal(field in payload, false, `${field} must not reach the provider`);
  }
  for (const field of ['candidateId', 'company', 'role', 'url', 'description', 'mandatorySignals']) {
    assert.ok(field in payload, `${field} is needed for scoring`);
  }
});

test('a full candidate set stays well inside the scan context budget', () => {
  const jobs = jobsFor('ats', DEFAULT_CANDIDATE_LIMIT).map((job) => ({
    ...job, description: 'x'.repeat(4000), requirements: 'y'.repeat(4000),
  }));
  const { candidates } = compactCandidates({ ats: { jobs } }, DEFAULT_CANDIDATE_LIMIT);
  const payload = JSON.stringify(candidates.map(promptCandidate));
  // Guards against silent prompt growth: 60 maximally verbose adverts must stay
  // far below the 280,000-character assembled-context limit so the profile,
  // calibration and CV still fit.
  assert.equal(candidates.length, DEFAULT_CANDIDATE_LIMIT);
  assert.ok(payload.length < 140_000, `prompt candidates grew to ${payload.length} characters`);
});

test('a verification pass re-examines only what the primary scan decided today', () => {
  const candidates = [
    { candidateId: 'candidate-001', url: 'https://x.test/kept', sources: ['https://x.test/kept'] },
    { candidateId: 'candidate-002', url: 'https://x.test/near', sources: ['https://x.test/near'] },
    { candidateId: 'candidate-003', url: 'https://x.test/unrelated', sources: ['https://x.test/unrelated'] },
    { candidateId: 'candidate-004', url: 'https://x.test/old', sources: ['https://x.test/old'] },
  ];
  const tracker = { opportunities: [
    { id: 'a', status: 'shortlist', score: 82, lastChecked: '2026-07-22', sources: ['https://x.test/kept'] },
    { id: 'b', status: 'watch', score: 47, lastChecked: '2026-07-22', sources: ['https://x.test/near'] },
    { id: 'c', status: 'shortlist', score: 12, lastChecked: '2026-07-22', sources: ['https://x.test/unrelated'] },
    { id: 'd', status: 'shortlist', score: 90, lastChecked: '2026-07-01', sources: ['https://x.test/old'] },
  ] };
  const result = verificationCandidates(candidates, tracker, '2026-07-22', { checkScore: 55 });
  assert.equal(result.verified, true);
  // Today's keeper and the near-threshold watch item, not the clearly rejected
  // one and not an entry from an earlier day.
  assert.deepEqual(result.candidates.map((item) => item.candidateId), ['candidate-001', 'candidate-002']);
});

test('a verification pass with nothing from today falls back to the full set', () => {
  const candidates = [{ candidateId: 'candidate-001', url: 'https://x.test/1', sources: ['https://x.test/1'] }];
  const empty = verificationCandidates(candidates, { opportunities: [] }, '2026-07-22', {});
  assert.equal(empty.verified, false);
  assert.deepEqual(empty.candidates, candidates);

  const unmatched = verificationCandidates(candidates, {
    opportunities: [{ id: 'z', status: 'new', score: 80, lastChecked: '2026-07-22', sources: ['https://other.test/9'] }],
  }, '2026-07-22', {});
  assert.equal(unmatched.verified, false);
  assert.deepEqual(unmatched.candidates, candidates);
});

test('inbox recheck covers only untouched new jobs and skips rediscovered roles', () => {
  const tracker = {
    opportunities: [
      { id: 'stale', company: 'Old Co', role: 'Engineer', status: 'new', sources: ['https://example.test/jobs/old'] },
      { id: 'missing', company: 'No Link', role: 'Engineer', status: 'new', sources: [] },
      { id: 'chosen', company: 'Chosen', role: 'Engineer', status: 'shortlist', sources: ['https://example.test/jobs/chosen'] },
      { id: 'fresh', company: 'Fresh Co', role: 'Engineer', status: 'new', sources: ['https://example.test/jobs/fresh'] },
    ],
  };
  const incoming = [{ company: 'Fresh Co', role: 'Engineer', url: 'https://example.test/jobs/fresh' }];
  const result = inboxRecheckCandidates(tracker, incoming);
  assert.deepEqual(result.checkable.map((item) => item._trackerId), ['stale']);
  assert.deepEqual(result.missingSource.map((item) => item._trackerId), ['missing']);
});

test('scan artifacts archive only stale untriaged jobs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-inbox-recheck-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify({
    updated: '2026-07-24',
    opportunities: [
      { id: 'stale', company: 'Old Co', role: 'Engineer', status: 'new', tags: [], sources: ['https://example.test/careers'] },
      { id: 'chosen', company: 'Chosen', role: 'Engineer', status: 'shortlist', tags: [], sources: ['https://example.test/jobs/chosen'] },
    ],
  })}\n`);
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: {}, candidates: [], assessmentResult: null,
    policy: {}, startedAt: new Date().toISOString(), inboxRechecked: 1,
    staleInboxEntries: [{ _trackerId: 'stale', liveness: { reason: 'URL is a job-board index, not an individual advert' } }],
  });
  assert.equal(artifacts.tracker.opportunities.find((item) => item.id === 'stale').status, 'ignore');
  assert.equal(artifacts.tracker.opportunities.find((item) => item.id === 'chosen').status, 'shortlist');
  assert.equal(artifacts.run.inbox_rechecked, 1);
  assert.equal(artifacts.run.inbox_archived, 1);
});
