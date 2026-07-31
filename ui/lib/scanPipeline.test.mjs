import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assessScanCandidates, assessmentCandidatesForSelection, buildAssessmentPrompt, compactCandidates, createRankedDiscoveryStages, DEFAULT_CANDIDATE_LIMIT, gateAssessment, inboxRecheckCandidates, prepareRankedDiscovery, promptCandidate,
  filterVacancies, PipelineInterruptedError, readVacancyDecisionHistory, runScanPipeline, validateAssessments, validateWrittenScanArtifacts,
  verificationCandidates, writeScanArtifacts,
} from './scanPipeline.mjs';
import { claimNextScanRequest, enqueueScanRequest, projectScanQueue } from './scanQueue.mjs';
import { acquireScanLease, currentLeaseOwner, readScanLease, releaseScanLease } from './scanLease.mjs';
import {
  appendRunEvent, openRunJournal, replayRunJournal, validateRunJournal,
} from './runJournal.mjs';
import { ProviderLifecycleUnclosedError } from './structuredTurn.mjs';
import { applyPreparedMutation, prepareMutation } from './mutationCoordinator.mjs';
import { scanReportRecipe } from './scanMutationProjection.mjs';

const dimensions = [{ name: 'Fit', score: 90, maximum: 100, evidence: 'Advert and profile' }];
const assessment = (status = 'met') => ({
  candidateId: 'candidate-001',
  summary: 'Synthetic fit',
  responsibilityFit: {
    rating: 'strong',
    advertEvidence: 'The advert requires systems delivery.',
    profileEvidence: 'Built production systems.',
    explanation: 'The responsibility evidence aligns.',
  },
  mandatoryRequirements: [{ requirement: 'AWS', advertEvidence: 'AWS is required', advertEvidenceId: 'provider-aws', status, profileEvidence: status === 'met' ? 'Built systems on AWS' : null }],
  transferableExperience: [{
    advertNeed: 'Deliver reliable services.',
    profileEvidence: 'Delivered a related service.',
    relevance: 'strong',
    explanation: 'The operating constraints transfer directly.',
  }],
  uncertainties: ['Team scale is not stated.'],
  strengths: [{
    point: 'Direct systems evidence.',
    advertEvidence: 'The advert requires systems delivery.',
    profileEvidence: 'Built production systems.',
  }],
  concerns: [{
    point: 'Team scale remains unknown.',
    advertEvidence: 'The advert does not state team size.',
    profileEvidence: null,
  }],
  recommendation: 'keep',
});

test('assessment prompt confines providers to nuanced evidence and recommendations', () => {
  const context = { candidates: [{ candidateId: 'candidate-001' }] };
  const prompt = buildAssessmentPrompt(context);
  assert.match(prompt, /already normalised, deduplicated, filtered, ranked and selected/);
  assert.match(prompt, /responsibility fit/);
  assert.match(prompt, /transferable experience/);
  assert.match(prompt, /uncertainty/);
  assert.match(prompt, /strengths and concerns/);
  assert.doesNotMatch(prompt, /Use a 100-point evidence-led breakdown/);
  assert.doesNotMatch(prompt, /Apply hard exclusions before scoring/);
  assert.deepEqual(JSON.parse(prompt.split('\n\n').at(-1)), context);
});

test('candidate input is deduplicated, capped and descriptions are bounded', () => {
  const job = { company: 'Acme', title: 'Engineer', url: 'https://example.test/job', description: 'x'.repeat(2000) };
  const { candidates: result } = compactCandidates({ one: { jobs: [job, job] } }, 40);
  assert.equal(result.length, 1);
  assert.equal(result[0].description.length, 1200);
});

test('ranked discovery is independent of source and portal order', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-123456789abc',
    target: { primaryTitles: [{ value: 'Ideal Role', strength: 'strong-preference', provenance: 'explicit' }] },
    negative: {}, compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  };
  const job = (company) => ({ company, title: 'Ideal Role', url: `https://example.test/${company.toLowerCase()}`, providerId: company.toLowerCase() });
  const options = { profile, tracker: { opportunities: [] }, runId: 'scan-1', limit: 60 };
  const forward = prepareRankedDiscovery({ sources: {
    'ats-a': { count: 1, jobs: [job('Able')] }, 'ats-b': { count: 1, jobs: [job('Baker')] },
  }, ...options });
  const reverse = prepareRankedDiscovery({ sources: {
    'ats-b': { count: 1, jobs: [job('Baker')] }, 'ats-a': { count: 1, jobs: [job('Able')] },
  }, ...options });
  assert.deepEqual(forward.selection.selected.map((item) => item.url), reverse.selection.selected.map((item) => item.url));
  assert.deepEqual(forward.candidates.map((item) => item.candidateId), ['candidate-001', 'candidate-002']);
});

test('ranked discovery preserves role-family and location metadata for soft diversification', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-diversity',
    target: { primaryTitles: [{ value: 'Ideal Role', strength: 'mandatory', provenance: 'explicit' }] },
    negative: {},
    compensation: {
      currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  };
  const job = (id, { roleFamily = 'engineering', location = 'London' } = {}) => ({
    company: 'Shared Employer',
    title: 'Ideal Role',
    url: `https://example.test/${id}`,
    providerId: id,
    roleFamily,
    location,
  });
  const dominantFamilies = Array.from({ length: 12 }, (_, index) => job(`family-a-${index}`));
  const alternativeFamilies = Array.from({ length: 6 }, (_, index) => job(`family-z-${index}`, {
    roleFamily: index % 2 ? 'operations' : 'research',
  }));
  const familyResult = prepareRankedDiscovery({
    sources: { ats: { count: 18, jobs: [...dominantFamilies, ...alternativeFamilies] } },
    profile, tracker: { opportunities: [] }, runId: 'role-family-diversity', limit: 10,
  });

  assert.ok(familyResult.ranked.every(({ roleFamily }) => roleFamily));
  assert.ok(familyResult.selection.selected.filter(({ roleFamily }) => roleFamily === 'engineering').length <= 5);
  assert.equal(familyResult.selection.constraintsRelaxed.includes('roleFamily'), false);

  const dominantLocations = Array.from({ length: 12 }, (_, index) => job(`location-a-${index}`));
  const alternativeLocations = Array.from({ length: 6 }, (_, index) => job(`location-z-${index}`, {
    location: index % 2 ? 'Manchester' : 'Bristol',
  }));
  const locationResult = prepareRankedDiscovery({
    sources: { ats: { count: 18, jobs: [...dominantLocations, ...alternativeLocations] } },
    profile, tracker: { opportunities: [] }, runId: 'location-diversity', limit: 10,
  });

  assert.ok(locationResult.selection.selected.filter(({ location }) => location === 'London').length <= 5);
  assert.equal(locationResult.selection.constraintsRelaxed.includes('location'), false);
});

test('URL-less provider vacancies retain distinct stable identities through selection', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-url-less-identities',
    target: {},
    negative: {},
    compensation: {
      currency: null, period: 'year', minimum: null,
      minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  };
  const sources = {
    provider: {
      count: 2,
      jobs: [
        {
          company: 'Example Co', title: 'Engineer',
          providerId: 'provider-reference-1', description: 'Build service one.',
        },
        {
          company: 'Example Co', title: 'Engineer',
          providerId: 'provider-reference-2', description: 'Build service two.',
        },
      ],
    },
  };
  const forward = prepareRankedDiscovery({
    sources, profile, runId: 'url-less-forward', relevanceThreshold: 0,
  });
  const reverse = prepareRankedDiscovery({
    sources: { provider: { ...sources.provider, jobs: [...sources.provider.jobs].reverse() } },
    profile,
    runId: 'url-less-reverse',
    relevanceThreshold: 0,
  });

  assert.equal(forward.ranked.length, 2);
  assert.equal(new Set(forward.ranked.map(({ vacancyId }) => vacancyId)).size, 2);
  assert.ok(forward.ranked.every(({ vacancyId }) => /^vacancy-ref-[a-f0-9]{24}$/.test(vacancyId)));
  assert.deepEqual(
    forward.ranked.map(({ vacancyId }) => vacancyId),
    reverse.ranked.map(({ vacancyId }) => vacancyId),
  );
  assert.ok(forward.selection.reasons.every(({ vacancyId }) => vacancyId !== 'unknown-vacancy'));
});

test('durable ranked stages preserve the established ranked discovery result', async () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-durable',
    target: { primaryTitles: [{ value: 'Ideal Role', strength: 'strong-preference', provenance: 'explicit' }] },
    negative: {}, compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  };
  const sources = {
    ats: {
      count: 2,
      jobs: [
        { company: 'Able', title: 'Ideal Role', url: 'https://example.test/able', providerId: 'able' },
        { company: 'Baker', title: 'Other Role', url: 'https://example.test/baker', providerId: 'baker' },
      ],
    },
  };
  const options = { profile, tracker: { opportunities: [] }, runId: 'durable-run', limit: 60 };
  const expected = prepareRankedDiscovery({ sources, ...options });
  const stages = createRankedDiscoveryStages({
    collect: async () => ({ generatedAt: '2026-07-27T10:00:00.000Z', queries: ['ideal'], sources }),
    profile,
    tracker: options.tracker,
    limit: options.limit,
  });
  let priorArtifact = null;
  for (const stageId of DURABLE_STAGES) {
    priorArtifact = await stages[stageId]({
      run: { runId: options.runId },
      lease: { runId: options.runId },
      priorArtifact,
    });
  }

  assert.deepEqual(priorArtifact, {
    discoveryCounts: expected.discoveryCounts,
    exclusions: expected.exclusions,
    reconsidered: expected.reconsidered,
    ranked: expected.ranked,
    selection: expected.selection,
    funnel: expected.funnel,
    candidates: expected.candidates,
  });
});

test('ranked discovery excludes zero-score unrelated vacancies below the configured relevance threshold', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-123456789abc',
    target: { primaryTitles: [{ value: 'Ideal Role', strength: 'strong-preference', provenance: 'explicit' }] },
    negative: {},
    compensation: {
      currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  };
  const result = prepareRankedDiscovery({
    sources: { ats: { count: 2, jobs: [
      { company: 'Strong', title: 'Ideal Role', url: 'https://example.test/strong', providerId: 'strong' },
      { company: 'Noise', title: 'Unrelated Role', url: 'https://example.test/noise', providerId: 'noise' },
    ] } },
    profile,
    tracker: { opportunities: [] },
    runId: 'scan-threshold',
    limit: 60,
    relevanceThreshold: 40,
  });

  assert.deepEqual(result.selection.selected.map((item) => item.role), ['Ideal Role']);
  assert.equal(result.funnel.ranked, 2);
  assert.equal(result.funnel.aboveThreshold, 1);
  assert.equal(result.funnel.selected, 1);
});

test('ranked discovery backfills assessment capacity instead of re-assessing an unchanged rejection', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-current',
    target: { primaryTitles: [{ value: 'Ideal Role', strength: 'strong-preference', provenance: 'explicit' }] },
    negative: {},
    compensation: {
      currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  };
  const sources = { ats: { count: 2, jobs: [
    {
      company: 'Already Reviewed',
      title: 'Ideal Role',
      url: 'https://example.test/rejected',
      providerId: 'rejected',
      description: 'Deliver the ideal role responsibilities.',
    },
    {
      company: 'Fresh Candidate',
      title: 'Ideal Role',
      url: 'https://example.test/fresh',
      providerId: 'fresh',
      description: 'Deliver the ideal role responsibilities.',
    },
  ] } };
  const initial = prepareRankedDiscovery({
    sources, profile, tracker: { opportunities: [] }, runId: 'initial', limit: 2,
  });
  const rejected = initial.ranked.find((item) => item.company === 'Already Reviewed');
  const result = prepareRankedDiscovery({
    sources,
    profile,
    tracker: { opportunities: [] },
    decisionHistory: [{
      company: rejected.company,
      role: rejected.role,
      url: rejected.url,
      source: rejected.source,
      outcome: 'below_threshold',
      profileId: profile.id,
      contentFingerprint: rejected.contentFingerprint,
    }],
    runId: 'repeat',
    limit: 1,
  });

  assert.equal(result.ranked.length, 2);
  assert.equal(Object.hasOwn(result.ranked[0], 'observations'), false);
  assert.deepEqual(result.selection.selected.map((item) => item.company), ['Fresh Candidate']);
  assert.deepEqual(result.selection.assessmentSkipped.map((item) => ({
    company: item.company,
    reason: item.lifecycle.reason,
  })), [{ company: 'Already Reviewed', reason: 'unchanged-rejection' }]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.funnel.selected, 1);
});

test('published learning reranks unassessed jobs, reconsiders scoped exclusions and reuses prior decisions', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-learning-flow',
    target: {
      primaryTitles: [{
        value: 'Data Engineer',
        strength: 'mandatory',
        provenance: 'explicit',
      }],
    },
    negative: {},
    compensation: {
      currency: null, period: 'year', minimum: null,
      minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  };
  const sources = { ats: { count: 3, jobs: [
    {
      company: 'Reviewed Co', title: 'Data Engineer', location: 'London',
      roleFamily: 'Data Engineering',
      url: 'https://example.test/reviewed', providerId: 'reviewed',
    },
    {
      company: 'Preferred Co', title: 'Data Engineer', location: 'Manchester',
      roleFamily: 'Data Engineering',
      url: 'https://example.test/preferred', providerId: 'preferred',
    },
    {
      company: 'Adjacent Co', title: 'Software Engineer', location: 'Bristol',
      roleFamily: 'Software Engineering',
      url: 'https://example.test/adjacent', providerId: 'adjacent',
    },
  ] } };
  const initial = prepareRankedDiscovery({
    sources, profile, tracker: { opportunities: [] }, runId: 'learning-initial', limit: 3,
  });
  const reviewed = initial.ranked.find(({ company }) => company === 'Reviewed Co');
  const result = prepareRankedDiscovery({
    sources,
    profile,
    tracker: { opportunities: [] },
    decisionHistory: [{
      company: reviewed.company,
      role: reviewed.role,
      url: reviewed.url,
      source: reviewed.source,
      outcome: 'below_threshold',
      profileId: profile.id,
      contentFingerprint: reviewed.contentFingerprint,
    }],
    learningPolicy: {
      id: 'learning-reviewed',
      version: 1,
      changes: [
        {
          kind: 'rank-adjustment',
          field: 'location',
          value: 'Manchester',
          weight: 8,
          scope: 'profile-wide',
          proposalId: 'proposal-location',
        },
        {
          kind: 'reconsider-rule',
          profileRuleId: 'rule-data-engineer',
          scope: 'role-family',
          value: 'Software Engineering',
          proposalId: 'proposal-adjacent',
        },
        {
          kind: 'rank-adjustment',
          field: 'title',
          value: 'Software Engineer',
          weight: 8,
          scope: 'role-family',
          scopeValue: 'Software Engineering',
          proposalId: 'proposal-adjacent-rank',
        },
      ],
    },
    runId: 'learning-published',
    limit: 2,
  });

  assert.equal(result.ranked[0].company, 'Preferred Co');
  assert.equal(result.ranked[0].learningAdjustment, 8);
  assert.deepEqual(result.reconsidered.map(({ vacancyId }) => vacancyId), [
    result.ranked.find(({ company }) => company === 'Adjacent Co').vacancyId,
  ]);
  assert.deepEqual(result.selection.selected.map(({ company }) => company), [
    'Preferred Co', 'Adjacent Co',
  ]);
  assert.deepEqual(result.selection.assessmentSkipped.map(({ company, lifecycle }) => ({
    company, reason: lifecycle.reason,
  })), [{ company: 'Reviewed Co', reason: 'unchanged-rejection' }]);
});

test('deterministic exclusion accounting counts unique vacancies while retaining every rule explanation', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-123456789abc',
    target: {},
    negative: {
      excludedTitles: [{ value: 'Blocked Role', strength: 'hard-exclusion', provenance: 'explicit' }],
      excludedEmployers: [{ value: 'Blocked Co', strength: 'hard-exclusion', provenance: 'explicit' }],
    },
    compensation: {
      currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  };
  const result = prepareRankedDiscovery({
    sources: { ats: { count: 1, jobs: [{
      company: 'Blocked Co', title: 'Blocked Role', url: 'https://example.test/blocked', providerId: 'blocked',
    }] } },
    profile,
    tracker: { opportunities: [] },
    runId: 'scan-exclusions',
  });

  assert.equal(result.funnel.deterministicallyExcluded, 1);
  assert.equal(result.exclusions.length, 2);
  assert.deepEqual(result.exclusions.map((item) => item.code).sort(), ['excluded-employer', 'excluded-title']);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-unique-exclusion-accounting-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-27","opportunities":[]}\n');
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex',
    mode: 'primary',
    sources: { ats: { configured: true, status: 'healthy', count: 1 } },
    candidates: [],
    assessmentResult: null,
    policy: {},
    startedAt: '2026-07-27T09:00:00Z',
    hardExcluded: result.exclusions,
    exclusions: result.exclusions,
    funnel: result.funnel,
    discoveryEngine: 'ranked-discovery',
    profileId: profile.id,
  });
  assert.equal(artifacts.run.discarded.hard_exclusion, 1);
  assert.equal(artifacts.run.explanations.length, 1);
  assert.deepEqual(
    artifacts.run.explanations[0].deterministic_exclusions.sort(),
    ['excluded-employer', 'excluded-title'],
  );
});

test('explicit provider compensation remains comparable through ranked discovery', () => {
  const profile = {
    version: 1, status: 'published', id: 'profile-123456789abc',
    target: {},
    negative: {},
    compensation: {
      currency: 'GBP', period: 'year', rateType: 'salary',
      minimum: 60000, minimumStrength: 'strong-preference', unknownPolicy: 'exclude',
    },
  };
  const result = prepareRankedDiscovery({
    sources: { adzuna: { count: 1, jobs: [{
      company: 'Comparable Co',
      title: 'Comparable Role',
      url: 'https://example.test/comparable',
      providerId: 'comparable',
      salaryMin: 65000,
      salaryMax: 70000,
      salaryCurrency: 'GBP',
      salaryPeriod: 'year',
      salaryRateType: 'salary',
    }] } },
    profile,
    tracker: { opportunities: [] },
    runId: 'scan-compensation',
    relevanceThreshold: 1,
  });

  assert.equal(result.exclusions.length, 0);
  assert.equal(result.selection.selected.length, 1);
  const dimension = result.ranked[0].dimensions.find((item) => item.name === 'compensation');
  assert.equal(dimension.evidence[0].comparison, 'meets-minimum');
  assert.equal(result.ranked[0].preRankScore, 100);
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
  assert.equal(gateAssessment(missingRust, { actionScore: 70, checkScore: 55 }, { preRankScore: 90 }).score, 69);
  assert.equal(gateAssessment(missingRust, { actionScore: 70, checkScore: 55 }, { preRankScore: 90 }).eligibility, 'check');
});

test('mandatory and recommendation gates use Scout deterministic scores and bands', () => {
  const candidate = { candidateId: 'candidate-001', preRankScore: 90 };
  assert.deepEqual(gateAssessment(assessment('unmet'), { actionScore: 70, checkScore: 55 }, candidate), {
    eligibility: 'ineligible', score: 54, keep: false, reasons: ['AWS'],
  });
  assert.deepEqual(gateAssessment(assessment('unknown'), { actionScore: 70, checkScore: 55 }, candidate), {
    eligibility: 'check', score: 69, keep: true, reasons: ['AWS'],
  });
  const discarded = { ...assessment('met'), recommendation: 'discard' };
  assert.equal(gateAssessment(discarded, { actionScore: 70, checkScore: 55 }, candidate).keep, false);
  assert.equal(gateAssessment(assessment('met'), { actionScore: 70, checkScore: 55 }, { preRankScore: 82 }).score, 82);
  assert.throws(
    () => validateAssessments(
      { assessments: [{ ...assessment('met'), dimensions }] },
      [{ candidateId: 'candidate-001' }],
    ),
    /assessment validation failed/,
  );
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
  assert.equal(artifacts.run.schemaVersion, 5);
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

test('scan artifact builder sanitises source reasons and failure text before persistence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-sanitised-scan-reasons-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex',
    mode: 'primary',
    sources: {
      ats: {
        configured: true,
        status: 'failed',
        count: 0,
        reason: `raw provider response at ${['C:', 'Users', 'private', 'response.json'].join('\\')} https://user:pass@example.test/debug?utm_source=private#body`,
      },
    },
    candidates: [],
    assessmentResult: null,
    policy: {},
    startedAt: '2026-07-14T10:00:00Z',
    error: `full private prompt saved at ${['', 'home', 'private', 'prompt.txt'].join('/')}`,
  });
  const persisted = [
    JSON.stringify(artifacts.run),
    fs.readFileSync(artifacts.report, 'utf8'),
    fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8'),
  ].join('\n');

  assert.doesNotMatch(persisted, /raw provider response|full private prompt|C:\\Users|\/home\/private|user:pass|utm_source|#body/i);
  assert.match(artifacts.run.source_health.ats.reason, /redacted/i);
  assert.match(artifacts.run.errors[0], /redacted/i);
});

test('scan artifact exposes a reconciled funnel without claiming all jobs were assessed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-ranked-scan-artifact-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const candidates = Array.from({ length: 60 }, (_, index) => ({
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`, company: `Company ${index + 1}`,
    vacancyId: `vacancy-${index + 1}`, role: 'Engineer',
    url: `https://example.test/jobs/${index + 1}`, source: 'ats',
    preRank: { vacancyId: `vacancy-${index + 1}`, score: 80, positive: ['title'], negative: [] },
    selectionReason: 'score-band',
  }));
  const exclusion = {
    vacancyId: 'vacancy-excluded', company: 'Excluded Company', role: 'Engineer',
    exclusionCode: 'confirmed-location', source: 'ats', url: 'https://example.test/excluded',
  };
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: { ats: { configured: true, status: 'healthy', count: 2532 } },
    candidates, assessmentResult: { assessments: candidates.slice(0, 59).map((candidate) => ({ ...assessment('met'), candidateId: candidate.candidateId })) },
    policy: {}, startedAt: '2026-07-26T09:00:00Z', profileId: 'profile-123456789abc', discoveryEngine: 'ranked-discovery',
    funnel: {
      sourceRecords: 2532, sourceErrors: 0, failedSourceRecords: 0, parsed: 2532,
      normalised: 2532, duplicateObservations: 2471, uniqueVacancies: 61,
      deterministicallyExcluded: 1, eligible: 60, ranked: 60, aboveThreshold: 60,
      selected: 60, assessed: 59, assessmentFailed: 1,
      added: 0, updated: 0, unchanged: 0, closed: 0,
      bySource: { ats: { count: 2532, failedRecords: 0, sourceErrors: 0 } },
    },
    ranked: candidates,
    selection: candidates.map((candidate) => ({
      vacancyId: candidate.vacancyId, score: 80, reason: 'deterministic-rank',
    })),
    selectionDecision: {
      threshold: 40, selected: candidates,
      reasons: candidates.map((candidate) => ({ vacancyId: candidate.vacancyId, reason: 'deterministic-rank' })),
      notSelected: [], assessmentSkipped: [],
    },
    exclusions: [exclusion],
  });
  assert.equal(artifacts.run.funnel.sourceRecords, 2532);
  assert.equal(artifacts.run.funnel.selected, 60);
  assert.equal(artifacts.run.funnel.assessed, 59);
  assert.equal(artifacts.run.funnel.assessmentFailed, 1);
  assert.equal(artifacts.run.candidates_found, 60);
  assert.equal(artifacts.run.profile_id, 'profile-123456789abc');
  assert.equal(artifacts.run.selection_summary.selected, 60);
  assert.equal(artifacts.run.explanations.length, 61);
  assert.deepEqual(Object.keys(artifacts.run.explanations[0]).sort(), [
    'above_threshold', 'assessment_status', 'company', 'deterministic_exclusion',
    'deterministic_exclusions', 'dimensions', 'outcome', 'pre_rank', 'reason_code',
    'role', 'selection_reason', 'source', 'sourceUrl', 'stages', 'vacancy_id',
  ].sort());
  assert.equal(artifacts.run.funnel.bySource.ats.uniqueVacancies, 61);
  assert.equal(artifacts.run.funnel.bySource.ats.duplicateObservations, 2471);
  assert.equal(artifacts.run.coverage.provider[0].assessed, 59);
  assert.doesNotMatch(JSON.stringify(artifacts.run), /description|profileEvidence/);
});

test('failed assessment reconciles selected candidates as assessment failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-failed-ranked-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-01","opportunities":[]}\n');
  const artifacts = writeScanArtifacts(root, {
    provider: 'codex', mode: 'primary', sources: {}, candidates: [{ candidateId: 'candidate-001', vacancyId: 'vacancy-1', company: 'A', role: 'Engineer', url: 'https://example.test/job', source: 'ats' }],
    assessmentResult: null, policy: {}, startedAt: '2026-07-26T09:00:00Z', error: 'provider failed',
    funnel: { selected: 1, assessed: 0, assessmentFailed: 0 },
  });
  assert.equal(artifacts.run.funnel.assessmentFailed, 1);
  assert.equal(artifacts.run.selection_summary.assessmentFailed, 1);
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
  assert.deepEqual(Object.keys(artifacts.run.reviewed[0]).sort(), [
    'categoryId', 'company', 'contentFingerprint', 'learningVersionId', 'outcome', 'profileId', 'reasons',
    'role', 'score', 'source', 'sourceUrl', 'vacancyId',
  ].sort());
  assert.doesNotMatch(JSON.stringify(artifacts.run.reviewed), /full advert|profileEvidence|Built systems/);

  const history = readVacancyDecisionHistory(root, { limit: 1 });
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'provider_discarded');
  assert.match(history[0].contentFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(history[0]).sort(), [
    'assessedAt', 'company', 'contentFingerprint', 'learningVersionId', 'outcome', 'profileId',
    'role', 'source', 'url', 'vacancyId',
  ].sort());
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

const DURABLE_STAGES = ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'];
const RECOVERY_COMPATIBILITY = Object.freeze({
  schemaVersion: 1,
  mode: 'primary',
  purpose: 'manual-discovery',
  profileVersion: 'profile-v1',
  sourceConfigFingerprint: 'a'.repeat(64),
  journalSchemaVersion: 1,
  artifactSchemaVersion: 1,
  pipelineVersion: 'pipeline-v1',
  rankingVersion: 'ranking-v1',
  promptVersion: 'prompt-v2',
  assessmentSchemaVersion: 2,
  provider: 'codex',
  model: 'provider-default',
  mutationSchemaVersion: 1,
  targetRevision: 'tracker-v1',
});

function durableStageHarness(calls) {
  return Object.fromEntries(DURABLE_STAGES.map((stageId) => [stageId, async ({
    run, lease, priorArtifact,
  }) => {
    assert.equal(run.runId, lease.runId);
    calls.set(stageId, (calls.get(stageId) || 0) + 1);
    return {
      stageId,
      stableIds: [...(priorArtifact?.stableIds || []), `${stageId}-1`],
    };
  }]));
}

test('committed durable stage boundaries let the existing heartbeat run between synchronous stages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-stage-boundary-heartbeat-'));
  let now = Date.parse('2026-07-30T08:00:00.000Z');
  const calls = new Map();
  const baseStages = durableStageHarness(calls);
  const stages = Object.fromEntries(DURABLE_STAGES.map((stageId) => [stageId, async (context) => {
    now += 20;
    return baseStages[stageId](context);
  }]));
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages,
      leaseOptions: {
        wallNow: () => now,
        monotonicNow: () => now,
        leaseDurationMs: 50,
        takeoverMarginMs: 0,
      },
      heartbeatOptions: {
        intervalMs: 10,
        wallNow: () => now,
        monotonicNow: () => now,
        setTimeoutFn(callback) { return setImmediate(callback); },
        clearTimeoutFn(timer) { clearImmediate(timer); },
      },
    });

    assert.equal(result.outcome, 'complete', JSON.stringify(result.failures));
    assert.deepEqual([...calls.keys()], DURABLE_STAGES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pipeline heartbeat inherits the injected lease clock unless explicitly overridden', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pipeline-shared-clock-'));
  let now = Date.parse('2026-07-30T08:00:00.000Z');
  let heartbeatTick = null;
  const calls = new Map();
  const baseStages = durableStageHarness(calls);
  const stages = {
    ...baseStages,
    collect: async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      now += 20;
      heartbeatTick();
      assert.equal(
        readScanLease(root).expiresAt,
        new Date(now + 100).toISOString(),
      );
      return baseStages.collect(context);
    },
  };
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages,
      leaseOptions: {
        wallNow: () => now,
        monotonicNow: () => now,
        leaseDurationMs: 100,
        takeoverMarginMs: 0,
      },
      heartbeatOptions: {
        intervalMs: 10,
        setTimeoutFn(callback) {
          heartbeatTick = callback;
          return { unref() {} };
        },
        clearTimeoutFn() {},
      },
    });

    assert.equal(result.outcome, 'complete', JSON.stringify(result.failures));
    assert.deepEqual([...calls.keys()], DURABLE_STAGES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable scan finalisation assesses real candidates in recoverable batches with partial repair', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-real-assessment-batches-'));
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    company: `Synthetic ${index + 1}`,
    role: 'Engineer',
    url: `https://example.test/jobs/${index + 1}`,
    description: 'Advert responsibility: build synthetic systems.',
    mandatorySignals: [{ id: 'mandatory-01', text: 'Advert mandatory requirement: systems evidence.' }],
  }));
  const makeAssessment = (candidateId, valid = true) => ({
    candidateId,
    summary: 'Evidence-led fit.',
    responsibilityFit: {
      rating: 'strong',
      advertEvidence: 'The advert requires systems delivery.',
      profileEvidence: 'The profile supplies systems evidence.',
      explanation: 'The responsibility evidence aligns.',
    },
    mandatoryRequirements: valid ? [{
      requirement: 'Systems evidence',
      advertEvidence: 'The advert requires systems evidence.',
      advertEvidenceId: 'mandatory-01',
      status: 'met',
      profileEvidence: 'The profile supplies systems evidence.',
    }] : [],
    transferableExperience: [],
    uncertainties: [],
    strengths: [{
      point: 'Direct systems evidence.',
      advertEvidence: 'The advert requires systems delivery.',
      profileEvidence: 'The profile supplies systems evidence.',
    }],
    concerns: [],
    recommendation: 'keep',
  });
  const calls = [];
  try {
    const durable = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      async finalize({ run, lease }) {
        return assessScanCandidates({
          run,
          lease,
          candidates,
          compatibility: RECOVERY_COMPATIBILITY,
          contextBudgetCharacters: 100_000,
          contextOverheadCharacters: 1_000,
          contextDigests: {
            scoringConfigDigest: '1'.repeat(64),
            profileDigest: '2'.repeat(64),
            calibrationDigest: '3'.repeat(64),
            masterCvDigest: '4'.repeat(64),
          },
          async invokeProvider({ kind, jobs }) {
            calls.push({ kind, ids: jobs.map((job) => job.candidateId) });
            return {
              assessments: jobs.map((job) => makeAssessment(
                job.candidateId,
                !(kind === 'batch' && job.candidateId === 'candidate-012'),
              )),
            };
          },
        });
      },
    });
    assert.equal(durable.outcome, 'complete');
    assert.equal(durable.stageOutputs.finalize.assessments.length, 12);
    assert.equal(durable.stageOutputs.finalize.failures.length, 0);
    assert.deepEqual(calls.map((call) => call.ids.length), [10, 2, 1]);
    assert.deepEqual(calls.at(-1), { kind: 'repair', ids: ['candidate-012'] });
    assert.equal(durable.manifest.assessmentBatches.length, 2);
    assert.equal(durable.manifest.assessmentJobs.length, 12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const interruptedAfter of DURABLE_STAGES) {
  test(`recovery reuses every committed artifact after interruption following ${interruptedAfter}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-durable-pipeline-'));
    const calls = new Map();
    let interruptedRunId;
    let now = Date.parse('2026-07-27T10:00:00.000Z');
    const leaseOptions = {
      wallNow: () => now,
      monotonicNow: () => now,
      leaseDurationMs: 1_000,
      takeoverMarginMs: 0,
    };
    try {
      await assert.rejects(
        runScanPipeline({
          root,
          compatibility: RECOVERY_COMPATIBILITY,
          stages: durableStageHarness(calls),
          leaseOptions,
          onStageCommitted({ stageId, run }) {
            if (stageId === interruptedAfter) {
              interruptedRunId = run.runId;
              now += 1_001;
              throw new PipelineInterruptedError(`stopped after ${stageId}`);
            }
          },
        }),
        PipelineInterruptedError,
      );
      assert.equal(readScanLease(root)?.runId, interruptedRunId);

      const beforeRecovery = Object.fromEntries(calls);
      const recovered = await runScanPipeline({
        root,
        compatibility: RECOVERY_COMPATIBILITY,
        stages: durableStageHarness(calls),
        leaseOptions,
      });

      assert.equal(recovered.runId, interruptedRunId);
      assert.equal(recovered.outcome, 'complete');
      assert.deepEqual(Object.keys(recovered).sort(), ['failures', 'manifest', 'outcome', 'runId']);
      const stopIndex = DURABLE_STAGES.indexOf(interruptedAfter);
      for (const stageId of DURABLE_STAGES.slice(0, stopIndex + 1)) {
        assert.equal(calls.get(stageId), beforeRecovery[stageId], `${stageId} must be reused`);
      }
      for (const stageId of DURABLE_STAGES.slice(stopIndex + 1)) {
        assert.equal(calls.get(stageId), 1, `${stageId} must execute once after recovery`);
      }
      assert.deepEqual(recovered.manifest.completedWork.map((work) => work.stageId), DURABLE_STAGES);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('pipeline selection admits a valid journal prefix so fenced recovery can quarantine its torn tail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-torn-pipeline-journal-'));
  let now = Date.parse('2026-07-27T10:00:00.000Z');
  let interruptedRun;
  const leaseOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
    leaseDurationMs: 1_000,
    takeoverMarginMs: 0,
  };
  try {
    await assert.rejects(
      runScanPipeline({
        root,
        compatibility: RECOVERY_COMPATIBILITY,
        stages: durableStageHarness(new Map()),
        leaseOptions,
        onStageCommitted({ stageId, run }) {
          if (stageId !== 'collect') return;
          interruptedRun = run;
          now += 1_001;
          throw new PipelineInterruptedError('stopped before torn append');
        },
      }),
      PipelineInterruptedError,
    );
    fs.appendFileSync(interruptedRun.file, '{"schemaVersion":');

    const recovered = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      leaseOptions,
    });

    assert.equal(recovered.runId, interruptedRun.runId);
    assert.equal(recovered.outcome, 'complete');
    assert.equal(validateRunJournal(interruptedRun.file).truncatedTail, false);
    assert.equal(
      fs.readdirSync(interruptedRun.directory)
        .filter((name) => name.startsWith('journal.truncated.')).length,
      1,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt recovery candidate is durably skipped outside its damaged run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-corrupt-recovery-candidate-'));
  const damagedRunId = 'damaged-recovery-run';
  const damagedDirectory = path.join(root, '.scout', 'runs', damagedRunId);
  fs.mkdirSync(damagedDirectory, { recursive: true });
  fs.writeFileSync(path.join(damagedDirectory, 'journal.jsonl'), '{"schemaVersion":1,"private":"damaged');
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
    });

    assert.equal(result.outcome, 'complete');
    assert.notEqual(result.runId, damagedRunId);
    const selections = fs.readFileSync(
      path.join(root, '.scout', 'recovery-selections.jsonl'),
      'utf8',
    ).trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
    const skipped = selections.at(-1).skipped.find((item) => item.runId === damagedRunId);
    assert.deepEqual(skipped, {
      runId: damagedRunId,
      outcome: 'abandoned',
      reasons: ['compatibility-missing'],
    });
    assert.equal(fs.readFileSync(path.join(damagedDirectory, 'journal.jsonl'), 'utf8'), '{"schemaVersion":1,"private":"damaged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale pipeline worker cannot commit another artifact or terminal event after takeover', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-stale-pipeline-'));
  let now = Date.parse('2026-07-27T10:00:00.000Z');
  let takeover;
  const leaseOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
    leaseDurationMs: 10_000,
    takeoverMarginMs: 0,
  };
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      leaseOptions,
      stages: durableStageHarness(new Map()),
      onStageCommitted({ stageId }) {
        if (stageId !== 'collect') return;
        now += 10_001;
        takeover = acquireScanLease(
          root,
          currentLeaseOwner(),
          { kind: 'scan', runId: 'successor-run', provider: 'codex', model: 'provider-default', mode: 'primary', phase: 'collect' },
          leaseOptions,
        );
        assert.ok(takeover);
      },
    });

    assert.equal(result.outcome, 'lease-lost');
    assert.equal(result.failures.length, 1);
    const events = replayRunJournal(path.join(root, '.scout', 'runs', result.runId, 'journal.jsonl'));
    assert.deepEqual(events.map((event) => event.type), ['run.started', 'stage.completed']);
    assert.equal(events.at(-1).stageId, 'collect');
  } finally {
    if (takeover) releaseScanLease(takeover);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal release drains the next queued request under a newer genuine fence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pipeline-queue-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  let activeGeneration;
  let primaryRunId;
  const drained = [];
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: {
        ...durableStageHarness(new Map()),
        collect: async ({ run, lease }) => {
          primaryRunId = run.runId;
          activeGeneration = lease.generation;
          for (const request of [
            {
              id: 'manual-request-1', key: 'manual-key-1',
              requestedAt: '2026-07-27T10:00:00.000Z', expiresAt: '2026-07-28T10:00:00.000Z',
              requester: 'manual', windowAt: null,
            },
            {
              id: 'manual-request-2', key: 'manual-key-2',
              requestedAt: '2026-07-27T10:01:00.000Z', expiresAt: '2026-07-28T10:01:00.000Z',
              requester: 'manual', windowAt: null,
            },
            {
              id: 'scheduled-request-1', key: 'scheduled-key-1',
              requestedAt: '2026-07-27T10:02:00.000Z', expiresAt: '2026-07-27T20:00:00.000Z',
              requester: 'scheduled', windowAt: '2026-07-27T20:00:00.000Z',
            },
          ]) enqueueScanRequest(root, {
            ...request,
            purpose: 'manual-discovery',
            compatibility: queueCompatibility,
            lease,
          });
          return { stageId: 'collect', stableIds: ['collect-1'] };
        },
      },
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:05:00.000Z'),
        async run(request, context) {
          const events = replayRunJournal(path.join(root, '.scout', 'runs', primaryRunId, 'journal.jsonl'));
          assert.equal(events.at(-1).type, 'run.completed');
          assert.equal(readScanLease(root)?.leaseId, context.lease.leaseId);
          drained.push({ id: request.id, generation: context.lease.generation });
          if (request.id === 'manual-request-1') throw new Error('synthetic queued scan failure');
          return (await runScanPipeline({
            root,
            compatibility: RECOVERY_COMPATIBILITY,
            stages: durableStageHarness(new Map()),
            claimedLease: context.lease,
          })).outcome;
        },
      },
    });

    assert.equal(result.outcome, 'complete');
    assert.deepEqual(drained.map((item) => item.id), [
      'manual-request-1',
      'manual-request-2',
      'scheduled-request-1',
    ]);
    assert.ok(drained.every((item, index) => (
      item.generation > activeGeneration
      && (index === 0 || item.generation > drained[index - 1].generation)
    )));
    assert.equal(readScanLease(root), null);
    for (const requestId of ['manual-request-1', 'manual-request-2', 'scheduled-request-1']) {
      const requestRun = drained.find((item) => item.id === requestId);
      const runDirectories = fs.readdirSync(path.join(root, '.scout', 'runs'));
      const journal = runDirectories
        .map((runId) => path.join(root, '.scout', 'runs', runId, 'journal.jsonl'))
        .find((file) => replayRunJournal(file).some((event) => event.fencingGeneration === requestRun.generation));
      assert.ok(journal, `${requestId} must execute a journalled scan`);
      const requestEvents = replayRunJournal(journal);
      assert.equal(requestEvents.at(-1).type, 'run.completed');
      if (requestId === 'manual-request-1') {
        const failure = requestEvents.find((event) => event.type === 'run.failure-recorded');
        assert.equal(failure.payload.code, 'queue-run-failed-before-pipeline');
        assert.doesNotMatch(JSON.stringify(failure), /synthetic queued scan failure/);
      }
    }
    assert.deepEqual(
      projectScanQueue(root).requests.map((request) => [request.id, request.status]),
      [
        ['manual-request-1', 'failed'],
        ['manual-request-2', 'succeeded'],
        ['scheduled-request-1', 'succeeded'],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a blocked queued provider is skipped while the next healthy provider still runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-health-queue-isolation-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const healthChecks = [];
  const stageCalls = [];
  const queueLeaseOperations = [];
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: {
        ...durableStageHarness(new Map()),
        collect: async ({ lease }) => {
          for (const [id, requestedAt] of [
            ['claude-blocked', '2026-07-27T10:01:00.000Z'],
            ['codex-healthy', '2026-07-27T10:00:00.000Z'],
          ]) {
            enqueueScanRequest(root, {
              id,
              key: id,
              requestedAt,
              expiresAt: new Date(new Date(requestedAt).getTime() + 12 * 60 * 60 * 1000).toISOString(),
              requester: 'scheduled',
              windowAt: '2026-07-28T10:00:00.000Z',
              purpose: 'manual-discovery',
              compatibility: queueCompatibility,
              lease,
            });
          }
          return { stageId: 'collect', stableIds: ['direct'] };
        },
      },
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:05:00.000Z'),
        async run(request, context) {
          const provider = request.id.startsWith('claude') ? 'claude' : 'codex';
          queueLeaseOperations.push(readScanLease(root).operation);
          const queued = await runScanPipeline({
            root,
            compatibility: { ...RECOVERY_COMPATIBILITY, provider },
            claimedLease: context.lease,
            healthPreflight({ provider: checkedProvider }) {
              healthChecks.push(checkedProvider);
              return checkedProvider === 'claude'
                ? { ok: false, state: 'sign-in-required' }
                : { ok: true, state: 'ready' };
            },
            stages: Object.fromEntries(DURABLE_STAGES.map((stageId) => [stageId, async () => {
              stageCalls.push(`${provider}:${stageId}`);
              return { stageId, stableIds: [`${provider}:${stageId}`] };
            }])),
          });
          return queued.outcome === 'abandoned' ? 'skipped' : queued.outcome;
        },
      },
    });

    assert.equal(result.outcome, 'complete');
    assert.deepEqual(healthChecks, ['claude', 'codex']);
    assert.deepEqual(
      queueLeaseOperations.map((operation) => ({
        kind: operation.kind,
        phase: operation.phase,
        provider: operation.provider ?? null,
        model: operation.model ?? null,
        mode: operation.mode ?? null,
      })),
      [
        { kind: 'scan', phase: 'queue-drain', provider: null, model: null, mode: null },
        { kind: 'scan', phase: 'queue-drain', provider: null, model: null, mode: null },
      ],
    );
    assert.equal(stageCalls.some((call) => call.startsWith('claude:')), false);
    assert.equal(stageCalls.filter((call) => call.startsWith('codex:')).length, DURABLE_STAGES.length);
    assert.deepEqual(
      projectScanQueue(root).requests.map((request) => [request.id, request.status]),
      [['claude-blocked', 'skipped'], ['codex-healthy', 'succeeded']],
    );
    const journals = fs.readdirSync(path.join(root, '.scout', 'runs'))
      .map((runId) => replayRunJournal(path.join(root, '.scout', 'runs', runId, 'journal.jsonl')));
    const blocked = journals.find((events) => events.some((event) => (
      event.type === 'run.failure-recorded'
      && event.payload.code === 'provider-health-blocked'
    )));
    assert.deepEqual(blocked.map((event) => event.type), [
      'run.started',
      'run.failure-recorded',
      'run.completed',
    ]);
    assert.equal(blocked.at(-1).payload.outcome, 'abandoned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a transient provider-health lease is retried without queueing or stranding the scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-health-lease-race-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const healthLease = acquireScanLease(
    root,
    currentLeaseOwner(),
    {
      kind: 'provider-health',
      runId: 'provider-health-codex',
      provider: 'codex',
      phase: 'periodic',
    },
  );
  let waits = 0;
  let queueRuns = 0;
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      async waitForTransientLease() {
        waits += 1;
        releaseScanLease(healthLease);
      },
      queue: {
        compatibility: queueCompatibility,
        request: {
          id: 'manual-health-race',
          key: 'manual-health-race',
          requestedAt: '2026-07-29T08:00:00.000Z',
          expiresAt: '2026-07-29T20:00:00.000Z',
          requester: 'manual',
          windowAt: null,
          purpose: 'manual-discovery',
          compatibility: queueCompatibility,
        },
        async run() {
          queueRuns += 1;
          throw new Error('provider-health race must not create queue work');
        },
      },
    });

    assert.equal(result.outcome, 'complete');
    assert.equal(waits, 1);
    assert.equal(queueRuns, 0);
    assert.deepEqual(projectScanQueue(root).requests, []);
    assert.equal(readScanLease(root), null);
  } finally {
    try { releaseScanLease(healthLease); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('idle startup drains older compatible FIFO work before beginning an unqueued run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pipeline-startup-fifo-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const seed = acquireScanLease(
    root,
    currentLeaseOwner(),
    { kind: 'scan', runId: 'seed-queue', provider: 'codex', mode: 'primary', phase: 'queue' },
  );
  enqueueScanRequest(root, {
    id: 'older-request',
    key: 'older-request',
    requestedAt: '2026-07-27T10:00:00.000Z',
    expiresAt: '2026-07-28T10:00:00.000Z',
    requester: 'manual',
    windowAt: null,
    purpose: 'manual-discovery',
    compatibility: queueCompatibility,
    lease: seed,
  });
  releaseScanLease(seed);
  const order = [];
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: {
        ...durableStageHarness(new Map()),
        collect: async () => {
          order.push('direct');
          return { stageId: 'collect', stableIds: ['direct'] };
        },
      },
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:05:00.000Z'),
        async run(_request, context) {
          order.push('queued');
          return (await runScanPipeline({
            root,
            compatibility: RECOVERY_COMPATIBILITY,
            stages: durableStageHarness(new Map()),
            claimedLease: context.lease,
          })).outcome;
        },
      },
    });

    assert.equal(result.outcome, 'complete');
    assert.deepEqual(order, ['queued', 'direct']);
    assert.equal(projectScanQueue(root).requests[0].status, 'succeeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a claimed request whose complete live compatibility changed becomes durably stale without execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pipeline-claimed-stale-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const seed = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'seed-stale', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  enqueueScanRequest(root, {
    id: 'stale-before-run',
    key: 'stale-before-run',
    requestedAt: '2026-07-27T10:00:00.000Z',
    expiresAt: '2026-07-28T10:00:00.000Z',
    requester: 'manual',
    windowAt: null,
    purpose: 'manual-discovery',
    compatibility: queueCompatibility,
    lease: seed,
  });
  releaseScanLease(seed);
  let executions = 0;
  try {
    await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:05:00.000Z'),
        verify: async (_request, { phase }) => phase !== 'claim',
        async run() {
          executions += 1;
          return 'succeeded';
        },
      },
    });

    assert.equal(executions, 0);
    assert.equal(projectScanQueue(root).requests[0].status, 'stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a queued request is revalidated after its terminal evidence is durable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pipeline-terminal-stale-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const seed = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'seed-terminal-stale', provider: 'codex', mode: 'primary', phase: 'queue',
  });
  enqueueScanRequest(root, {
    id: 'stale-after-run',
    key: 'stale-after-run',
    requestedAt: '2026-07-27T10:00:00.000Z',
    expiresAt: '2026-07-28T10:00:00.000Z',
    requester: 'manual',
    windowAt: null,
    purpose: 'manual-discovery',
    compatibility: queueCompatibility,
    lease: seed,
  });
  releaseScanLease(seed);
  const phases = [];
  let executions = 0;
  try {
    await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:05:00.000Z'),
        verify: async (_request, { phase, manifest }) => {
          phases.push(phase);
          if (phase === 'terminal') {
            assert.equal(manifest.outcome, 'complete');
            return false;
          }
          return true;
        },
        async run(_request, context) {
          executions += 1;
          return (await runScanPipeline({
            root,
            compatibility: RECOVERY_COMPATIBILITY,
            stages: durableStageHarness(new Map()),
            claimedLease: context.lease,
          })).outcome;
        },
      },
    });

    assert.equal(executions, 1);
    assert.deepEqual(phases, ['claim', 'terminal']);
    assert.equal(projectScanQueue(root).requests[0].status, 'stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a terminal queued run is reconciled after its queue completion response is lost', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-queue-terminal-reconcile-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const oldLease = acquireScanLease(
    root,
    currentLeaseOwner(),
    { kind: 'scan', runId: 'orphan-terminal-run', provider: 'codex', model: 'provider-default', mode: 'primary', phase: 'queue-drain' },
  );
  try {
    enqueueScanRequest(root, {
      id: 'lost-completion',
      key: 'lost-completion',
      requestedAt: '2026-07-27T10:00:00.000Z',
      expiresAt: '2026-07-28T10:00:00.000Z',
      requester: 'manual',
      windowAt: null,
      purpose: 'manual-discovery',
      compatibility: queueCompatibility,
      lease: oldLease,
    });
    claimNextScanRequest(
      root,
      { ...queueCompatibility, purpose: 'manual-discovery' },
      oldLease,
      new Date('2026-07-27T10:01:00.000Z'),
    );
    const orphanRun = openRunJournal(root, oldLease.runId);
    appendRunEvent(orphanRun, {
      type: 'run.started',
      stageId: 'initialise',
      idempotencyKey: 'orphan-started',
      payload: { schemaVersion: 1, compatibility: RECOVERY_COMPATIBILITY },
    }, oldLease);
    appendRunEvent(orphanRun, {
      type: 'run.completed',
      stageId: 'finalise',
      idempotencyKey: 'orphan-completed',
      payload: { schemaVersion: 1, outcome: 'complete' },
    }, oldLease);
    releaseScanLease(oldLease);

    let reruns = 0;
    const primary = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:02:00.000Z'),
        async run() {
          reruns += 1;
          return 'succeeded';
        },
      },
    });

    assert.equal(primary.outcome, 'complete');
    assert.equal(reruns, 0);
    assert.equal(projectScanQueue(root).requests[0].status, 'succeeded');
    assert.equal(readScanLease(root), null);
  } finally {
    try { releaseScanLease(oldLease); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function assertOrphanedBackupOutcome(postSuccess, expectedQueueOutcome) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `scout-queue-${expectedQueueOutcome}-reconcile-`));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const seed = acquireScanLease(
    root,
    currentLeaseOwner(),
    { kind: 'scan', runId: `seed-${expectedQueueOutcome}`, provider: 'codex', mode: 'primary', phase: 'queue' },
  );
  let orphanLease;
  try {
    enqueueScanRequest(root, {
      id: `lost-${expectedQueueOutcome}`,
      key: `lost-${expectedQueueOutcome}`,
      requestedAt: '2026-07-27T10:00:00.000Z',
      expiresAt: '2026-07-28T10:00:00.000Z',
      requester: 'manual',
      windowAt: null,
      purpose: 'manual-discovery',
      compatibility: queueCompatibility,
      lease: seed,
    });
    releaseScanLease(seed);

    await assert.rejects(
      runScanPipeline({
        root,
        compatibility: RECOVERY_COMPATIBILITY,
        stages: durableStageHarness(new Map()),
        queue: {
          compatibility: queueCompatibility,
          now: new Date('2026-07-27T10:01:00.000Z'),
          async verify(_request, { phase }) {
            if (phase === 'terminal') throw new Error('synthetic lost queue completion response');
            return true;
          },
          async run(_request, context) {
            orphanLease = context.lease;
            const result = await runScanPipeline({
              root,
              compatibility: RECOVERY_COMPATIBILITY,
              stages: durableStageHarness(new Map()),
              claimedLease: context.lease,
              finalize: async () => ({
                schemaVersion: 1,
                result: { ok: true },
                mutationReceipt: {
                  schemaVersion: 1,
                  id: 'scan-tracker-report',
                  digest: 'f'.repeat(64),
                },
              }),
              postTerminalSuccess: async () => postSuccess,
            });
            return result.failures.some((failure) => failure.code === 'backup-partial')
              ? 'succeeded-partial'
              : result.failures.some((failure) => failure.code === 'backup-pending')
                ? 'succeeded-pending'
                : 'succeeded';
          },
        },
      }),
      /synthetic lost queue completion response/,
    );
    releaseScanLease(orphanLease);

    let reruns = 0;
    await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:02:00.000Z'),
        async run() {
          reruns += 1;
          return 'succeeded';
        },
      },
    });

    assert.equal(reruns, 0);
    assert.equal(projectScanQueue(root).requests[0].status, expectedQueueOutcome);
  } finally {
    try { releaseScanLease(orphanLease); } catch {}
    try { releaseScanLease(seed); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('orphan reconciliation preserves a terminal succeeded-pending backup outcome', async () => {
  await assertOrphanedBackupOutcome(
    { status: 'pending', reason: 'backup-offline' },
    'succeeded-pending',
  );
});

test('orphan reconciliation preserves a terminal succeeded-partial backup outcome', async () => {
  await assertOrphanedBackupOutcome(
    { status: 'partial', reason: 'backup-needs-attention' },
    'succeeded-partial',
  );
});

test('startup resumes an interrupted orphan claim under its original run id and reuses committed stages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-queue-orphan-resume-'));
  const queueCompatibility = {
    profileFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    schemaVersion: 1,
  };
  const calls = new Map();
  let resumedResult;
  const oldLease = acquireScanLease(
    root,
    currentLeaseOwner(),
    { kind: 'scan', runId: 'orphan-partial-run', provider: 'claude', model: 'provider-default', mode: 'primary', phase: 'queue-drain' },
  );
  enqueueScanRequest(root, {
    id: 'orphan-partial-request',
    key: 'orphan-partial-request',
    requestedAt: '2026-07-27T10:00:00.000Z',
    expiresAt: '2026-07-28T10:00:00.000Z',
    requester: 'manual',
    windowAt: null,
    purpose: 'manual-discovery',
    compatibility: queueCompatibility,
    lease: oldLease,
  });
  claimNextScanRequest(
    root,
    { ...queueCompatibility, purpose: 'manual-discovery' },
    oldLease,
    new Date('2026-07-27T10:01:00.000Z'),
  );
  try {
    await assert.rejects(
      runScanPipeline({
        root,
        compatibility: { ...RECOVERY_COMPATIBILITY, provider: 'claude' },
        stages: durableStageHarness(calls),
        claimedLease: oldLease,
        onStageCommitted({ stageId }) {
          if (stageId === 'collect') throw new PipelineInterruptedError();
        },
      }),
      PipelineInterruptedError,
    );
    releaseScanLease(oldLease);

    const resumedRunIds = [];
    const direct = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      queue: {
        compatibility: queueCompatibility,
        now: new Date('2026-07-27T10:02:00.000Z'),
        async run(_request, context) {
          resumedRunIds.push(context.runId);
          resumedResult = await runScanPipeline({
            root,
            compatibility: { ...RECOVERY_COMPATIBILITY, provider: 'claude' },
            stages: durableStageHarness(calls),
            claimedLease: context.lease,
          });
          return resumedResult.outcome;
        },
      },
    });

    assert.equal(direct.outcome, 'complete');
    assert.deepEqual(resumedRunIds, ['orphan-partial-run']);
    assert.equal(calls.get('collect'), 1);
    assert.equal(projectScanQueue(root).requests[0].status, 'succeeded', JSON.stringify(resumedResult));
  } finally {
    try { releaseScanLease(oldLease); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ranked stage artifacts contain semantic facts and no complete advert, diagnostic secret, or tracking content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-private-ranked-artifacts-'));
  const privateTail = `PRIVATE_TAIL_${'x'.repeat(4_000)}`;
  const profile = {
    version: 1, status: 'published', id: 'profile-private-artifacts',
    target: { primaryTitles: [{ value: 'Platform Engineer', strength: 'strong-preference', provenance: 'explicit' }] },
    negative: {},
    compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  };
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: createRankedDiscoveryStages({
        collect: async () => ({
          generatedAt: '2026-07-27T10:00:00.000Z',
          queries: ['platform'],
          sources: {
            ats: {
              configured: true,
              status: 'healthy',
              count: 1,
              [['access', 'Token'].join('')]: 'PRIVATE_ACCESS_TOKEN',
              response: { body: privateTail },
              jobs: [{
                company: 'Able',
                title: 'Platform Engineer',
                providerId: 'able-1',
                url: 'https://PRIVATE_USER:PRIVATE_PASSWORD@example.test/jobs/able'
                  + '?session=PRIVATE_SESSION&jwt=PRIVATE_JWT&code=PRIVATE_CODE&key=PRIVATE_KEY'
                  + '&sig=PRIVATE_SIG&ref=PRIVATE_REF&source=PRIVATE_SOURCE'
                  + '&redirect=https%3A%2F%2Fnested-user%3Anested-pass%40private.test%2Fsecret'
                  + '&utm_source=private&access_token=secret#PRIVATE_FRAGMENT',
                description: `Public bounded opening. ${privateTail}`,
                requirements: `AWS required. ${privateTail}`,
                rawHtml: `<html>${privateTail}</html>`,
                payload: privateTail,
                cookies: ['PRIVATE_COOKIE'],
              }],
              note: `request failed at https://example.test/debug?${'token'}=PRIVATE_DIAGNOSTIC_TOKEN&utm_source=private`,
              errors: ['Authorization Bearer PRIVATE_DIAGNOSTIC_TOKEN'],
            },
          },
        }),
        profile,
      }),
    });

    assert.equal(result.outcome, 'complete');
    const artifactDirectory = path.join(root, '.scout', 'runs', result.runId, 'artifacts');
    const persisted = fs.readdirSync(artifactDirectory)
      .map((name) => fs.readFileSync(path.join(artifactDirectory, name), 'utf8'))
      .join('\n');
    assert.doesNotMatch(
      persisted,
      /PRIVATE_ACCESS_TOKEN|PRIVATE_COOKIE|rawHtml|accessToken|utm_source|access_token/,
    );
    assert.doesNotMatch(
      persisted,
      /PRIVATE_USER|PRIVATE_PASSWORD|PRIVATE_SESSION|PRIVATE_JWT|PRIVATE_CODE|PRIVATE_KEY|PRIVATE_SIG|PRIVATE_REF|PRIVATE_SOURCE|PRIVATE_FRAGMENT|nested-user|nested-pass|redirect/,
    );
    assert.match(persisted, /https:\/\/example\.test\/jobs\/able/);
    assert.doesNotMatch(persisted, /PRIVATE_DIAGNOSTIC_TOKEN|Authorization|Bearer|request failed at/);
    assert.doesNotMatch(persisted, new RegExp(privateTail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(persisted, /"description"|"requirements"/);
    assert.doesNotMatch(persisted, /advertExcerpt|requirementExcerpt/);
    assert.match(persisted, /descriptionDigest|profileRuleMatches/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy stage artifacts preserve source order with exact semantic evidence and no advert prose', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-private-legacy-artifacts-'));
  const privateAdvert = 'PRIVATE_LEGACY_ADVERT AWS is mandatory for this role';
  const collected = {
    generatedAt: '2026-07-27T10:00:00.000Z',
    queries: ['engineer'],
    sources: {
      first_source: {
        configured: true,
        status: 'healthy',
        count: 1,
        jobs: [{
          company: 'First Co',
          title: 'Engineer',
          url: 'https://example.test/jobs/first?utm_source=private',
          description: privateAdvert,
        }],
      },
      second_source: {
        configured: true,
        status: 'healthy',
        count: 1,
        jobs: [{
          company: 'Second Co',
          title: 'Engineer',
          url: 'https://example.test/jobs/second',
          requirements: 'Kubernetes required',
        }],
      },
    },
  };
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: {
        collect: async () => collected,
        normalise: ({ priorArtifact }) => compactCandidates(priorArtifact.sources),
        deduplicate: ({ priorArtifact }) => priorArtifact,
        filter: ({ priorArtifact }) => priorArtifact,
        rank: ({ priorArtifact }) => priorArtifact,
        select: ({ priorArtifact }) => priorArtifact,
      },
    });

    assert.deepEqual(
      result.stageOutputs.select.candidates.map((candidate) => candidate.company),
      ['First Co', 'Second Co'],
    );
    assert.equal(result.stageOutputs.select.candidates[0].mandatorySignals.length, 1);
    assert.equal(
      result.stageOutputs.select.candidates[0].mandatorySignals[0].text,
      'Advert mandatory requirement: aws.',
    );
    const artifactDirectory = path.join(root, '.scout', 'runs', result.runId, 'artifacts');
    const persisted = fs.readdirSync(artifactDirectory)
      .map((name) => fs.readFileSync(path.join(artifactDirectory, name), 'utf8'))
      .join('\n');
    assert.doesNotMatch(persisted, /PRIVATE_LEGACY_ADVERT|private legacy advert|Kubernetes required|utm_source/i);
    assert.doesNotMatch(persisted, /"description"|"requirements"/);
    assert.match(persisted, /descriptionDigest|mandatorySignals/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic artifacts provide bounded readable assessment facts without complete advert sentences', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-readable-semantic-evidence-'));
  const description = 'Build distributed platforms for public services.';
  const requirement = 'Kubernetes is mandatory for production clusters.';
  const profile = {
    version: 1, status: 'published', id: 'profile-readable-evidence',
    target: {
      primaryTitles: [{ value: 'Platform Engineer', strength: 'strong-preference', provenance: 'explicit' }],
      sectors: [{ value: 'distributed platforms', strength: 'nice-to-have', provenance: 'explicit' }],
    },
    negative: {},
    compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  };
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: createRankedDiscoveryStages({
        collect: async () => ({
          generatedAt: '2026-07-28T09:00:00.000Z',
          queries: [],
          sources: {
            ats: {
              configured: true,
              status: 'healthy',
              count: 1,
              jobs: [{
                company: 'Readable Co',
                title: 'Platform Engineer',
                url: 'https://example.test/jobs/readable',
                description,
                requirements: requirement,
              }],
            },
          },
        }),
        profile,
      }),
    });

    const candidate = assessmentCandidatesForSelection(result.stageOutputs.select.selection.selected)[0];
    assert.match(candidate.description, /Advert responsibility: distributed platforms\./);
    assert.equal(
      candidate.mandatorySignals[0].text,
      'Advert mandatory requirement: kubernetes production clusters.',
    );
    const artifactDirectory = path.join(root, '.scout', 'runs', result.runId, 'artifacts');
    const persisted = fs.readdirSync(artifactDirectory)
      .map((name) => fs.readFileSync(path.join(artifactDirectory, name), 'utf8'))
      .join('\n');
    assert.doesNotMatch(persisted, new RegExp(description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(persisted, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(persisted, /distributed platforms|kubernetes production clusters/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh scan refuses storage pressure before its first lease, queue or journal append', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-storage-refusal-'));
  let executions = 0;
  let healthChecks = 0;
  try {
    await assert.rejects(
      runScanPipeline({
        root,
        compatibility: RECOVERY_COMPATIBILITY,
        storagePolicy: {
          maximumBytes: { runs: 0, artifacts: 0, queue: 0 },
          reserveBytes: 1,
        },
        stages: durableStageHarness(new Map()),
        healthPreflight() {
          healthChecks += 1;
          return { ok: true, state: 'ready' };
        },
        onStageCommitted() { executions += 1; },
      }),
      (error) => error?.code === 'SCOUT_STORAGE_PRESSURE',
    );
    assert.equal(executions, 0);
    assert.equal(healthChecks, 0);
    assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-queue.jsonl')), false);
    assert.equal(fs.existsSync(path.join(root, '.scout', 'runs')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credential-shaped semantic values are redacted while operators and accountability remain exact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-safe-semantic-clauses-'));
  const profile = {
    version: 1, status: 'published', id: 'profile-safe-semantic-clauses',
    target: {
      primaryTitles: [{ value: 'Platform Engineer', strength: 'strong-preference', provenance: 'explicit' }],
    },
    negative: {},
    compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  };
  const privateValues = [
    'hunter2',
    'PRIVATE_BEARER',
    'PRIVATE_TOKEN',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.PRIVATE_SIGNATURE',
    'credential-user',
    'credential-pass',
    'STANDALONE_KEY_VALUE',
    'PRIVATE_KEY_VALUE',
    'PRIVATE_DASH_KEY_VALUE',
    'PRIVATE_SPACE_KEY_VALUE',
    'SESSION_UNDERSCORE_VALUE',
    'SESSION_DASH_VALUE',
  ];
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: createRankedDiscoveryStages({
        collect: async () => ({
          generatedAt: '2026-07-28T09:00:00.000Z',
          queries: [],
          sources: {
            ats: {
              configured: true,
              status: 'healthy',
              count: 1,
              jobs: [{
                company: 'Safe Evidence Co',
                title: 'Platform Engineer',
                url: 'https://example.test/jobs/safe-evidence',
                description: 'Accountability for incident response. Non-technical applicants required.',
                requirements: [
                  `${['pass', 'word'].join('')}: ${['hunter', '2'].join('')}`,
                  ['Authorization:', 'Bearer', 'PRIVATE_BEARER'].join(' '),
                  `${['api', 'token'].join('_')}=${['PRIVATE', 'TOKEN'].join('_')}`,
                  'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.PRIVATE_SIGNATURE required',
                  'credential URL https://credential-user:credential-pass@example.test/private is required',
                  'key: STANDALONE_KEY_VALUE',
                  `${['PRIVATE', 'KEY'].join('_')}=${['PRIVATE', 'KEY', 'VALUE'].join('_')}`,
                  `${['private', 'key'].join('-')}: ${['PRIVATE', 'DASH', 'KEY', 'VALUE'].join('_')}`,
                  'Private Key = PRIVATE_SPACE_KEY_VALUE',
                  'session_id=SESSION_UNDERSCORE_VALUE',
                  'SESSION-ID: SESSION_DASH_VALUE',
                ].join('; '),
              }],
            },
          },
        }),
        profile,
      }),
    });

    const candidate = assessmentCandidatesForSelection(result.stageOutputs.select.selection.selected)[0];
    assert.match(candidate.description, /Advert responsibility: accountability incident response\./);
    assert.ok(candidate.mandatorySignals.some((signal) => /non technical applicants/.test(signal.text)));
    assert.equal(
      candidate.mandatorySignals.filter((signal) => /sensitive requirement redacted/.test(signal.text)).length,
      11,
    );
    const artifactDirectory = path.join(root, '.scout', 'runs', result.runId, 'artifacts');
    const persisted = fs.readdirSync(artifactDirectory)
      .map((name) => fs.readFileSync(path.join(artifactDirectory, name), 'utf8'))
      .join('\n');
    for (const value of privateValues) {
      assert.doesNotMatch(persisted, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantic recovery preserves a hard exclusion found after the old advert prefix bound', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-semantic-late-exclusion-'));
  const profile = {
    version: 1, status: 'published', id: 'profile-late-exclusion',
    target: {},
    negative: {
      excludedResponsibilities: [{
        value: 'operate gambling products',
        strength: 'hard-exclusion',
        provenance: 'explicit',
      }],
    },
    compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  };
  const calls = new Map();
  let now = Date.parse('2026-07-27T10:00:00.000Z');
  const leaseOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
    leaseDurationMs: 1_000,
    takeoverMarginMs: 0,
  };
  const heartbeatOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
  };
  const stages = createRankedDiscoveryStages({
    collect: async () => ({
      generatedAt: '2026-07-27T10:00:00.000Z',
      queries: [],
      sources: {
        ats: {
          configured: true,
          status: 'healthy',
          count: 1,
          jobs: [{
            company: 'Able',
            title: 'Platform Engineer',
            providerId: 'late-1',
            url: 'https://example.test/jobs/late',
            description: `${'Neutral platform work. '.repeat(100)} You must operate gambling products.`,
          }],
        },
      },
    }),
    profile,
  });
  for (const [id, execute] of Object.entries(stages)) {
    stages[id] = Object.assign(async (context) => {
      calls.set(id, (calls.get(id) || 0) + 1);
      return execute(context);
    }, { artifactCodec: execute.artifactCodec });
  }
  let runId;
  try {
    await assert.rejects(
      runScanPipeline({
        root,
        compatibility: RECOVERY_COMPATIBILITY,
        stages,
        leaseOptions,
        heartbeatOptions,
        onStageCommitted({ stageId, run }) {
          runId = run.runId;
          if (stageId === 'collect') {
            now += 1_001;
            throw new PipelineInterruptedError();
          }
        },
      }),
      PipelineInterruptedError,
    );
    const recovered = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages,
      leaseOptions,
      heartbeatOptions,
    });
    assert.equal(recovered.outcome, 'complete', JSON.stringify(recovered.failures));
    assert.equal(recovered.stageOutputs.select.selection.selected.length, 0);
    assert.equal(recovered.stageOutputs.select.exclusions[0].code, 'excluded-responsibility');
    assert.equal(calls.get('collect'), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persisted filtering keeps bounded source evidence from every canonical duplicate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-duplicate-exclusion-evidence-'));
  const profile = {
    version: 1, status: 'published', id: 'profile-duplicate-exclusion',
    target: {},
    negative: {
      excludedResponsibilities: [{
        value: 'operate gambling products',
        strength: 'hard-exclusion',
        provenance: 'explicit',
      }],
    },
    compensation: {
      currency: null, period: 'year', minimum: null,
      minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  };
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: createRankedDiscoveryStages({
        collect: async () => ({
          generatedAt: '2026-07-31T08:00:00.000Z',
          queries: [],
          sources: {
            adzuna: {
              configured: true,
              status: 'healthy',
              count: 1,
              jobs: [{
                company: 'Example Co',
                title: 'Platform Engineer',
                providerId: 'short-exclusion',
                url: 'https://example.test/jobs/shared',
                description: 'Operate gambling products.',
              }],
            },
            greenhouse: {
              configured: true,
              status: 'healthy',
              count: 1,
              jobs: [{
                company: 'Example Co',
                title: 'Platform Engineer',
                providerId: 'long-neutral',
                url: 'https://example.test/jobs/shared',
                description: 'Build and operate reliable public-interest platforms. '.repeat(20),
              }],
            },
          },
        }),
        profile,
      }),
    });

    assert.equal(result.stageOutputs.select.funnel.uniqueVacancies, 1);
    assert.equal(result.stageOutputs.select.exclusions.length, 1);
    const evidence = result.stageOutputs.select.exclusions[0].evidence.vacancy;
    assert.deepEqual(evidence.sources.map(({ source, providerId, provenance }) => ({
      source, providerId, provenance,
    })), [{
      source: 'adzuna',
      providerId: 'short-exclusion',
      provenance: 'deterministic-extraction',
    }]);
    assert.ok(evidence.sources.length <= 8);
    assert.match(evidence.sources[0].descriptionDigest, /^[a-f0-9]{64}$/);

    const persisted = fs.readdirSync(path.join(root, '.scout', 'runs', result.runId, 'artifacts'))
      .map((name) => fs.readFileSync(path.join(root, '.scout', 'runs', result.runId, 'artifacts', name), 'utf8'))
      .join('\n');
    assert.match(persisted, /short-exclusion/);
    assert.match(persisted, /deterministic-extraction/);
    assert.doesNotMatch(persisted, /Operate gambling products|Build and operate reliable public-interest platforms/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed canonical failure recorder cannot prevent the terminal run event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-failure-recorder-'));
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: {
        ...durableStageHarness(new Map()),
        collect: async () => {
          throw new Error('collection failed');
        },
      },
      recordFailure: async () => {
        throw new Error('failure report unavailable');
      },
    });

    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.failures.map((failure) => failure.code), [
      'stage-failed',
      'failure-record-failed',
    ]);
    const events = replayRunJournal(path.join(root, '.scout', 'runs', result.runId, 'journal.jsonl'));
    assert.equal(events.at(-1).type, 'run.completed');
    assert.equal(events.at(-1).payload.outcome, 'failed');
    assert.equal(readScanLease(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unclosed provider lifecycle remains auditable without stopping heartbeat or releasing its fence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-unclosed-'));
  let heartbeatStops = 0;
  const closure = new Promise(() => {});
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      heartbeatOptions: {
        intervalMs: 100,
        setTimeoutFn() { return { unref() {} }; },
        clearTimeoutFn() { heartbeatStops += 1; },
      },
      finalize: async () => {
        throw new ProviderLifecycleUnclosedError(
          'provider process did not close',
          closure,
        );
      },
    });

    assert.equal(result.outcome, 'in-progress');
    assert.deepEqual(result.failures, [{
      code: 'provider-lifecycle-unclosed',
      stage: 'finalise',
      reason: 'operator-intervention-required',
    }]);
    assert.equal(heartbeatStops, 0);
    const lease = readScanLease(root);
    assert.ok(lease, 'the unresolved external call must retain fenced authority');
    assert.equal(lease.runId, result.runId);
    const events = replayRunJournal(openRunJournal(root, result.runId).file);
    assert.ok(events.some((event) => (
      event.type === 'run.failure-recorded'
      && event.payload.code === 'provider-lifecycle-unclosed'
      && event.payload.reason === 'operator-intervention-required'
    )));
    assert.equal(events.some((event) => event.type === 'run.completed'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal evidence validation failure retains the lease for fenced recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-terminal-evidence-retained-'));
  let runId;
  try {
    await assert.rejects(
      runScanPipeline({
        root,
        compatibility: RECOVERY_COMPATIBILITY,
        stages: durableStageHarness(new Map()),
        onStageCommitted({ stageId, run }) {
          runId = run.runId;
          if (stageId === 'select') fs.renameSync(run.directory, `${run.directory}.unavailable`);
        },
      }),
      /ENOENT|no such file|cannot find/i,
    );
    assert.equal(readScanLease(root)?.runId, runId);
  } finally {
    const retained = readScanLease(root);
    if (retained) {
      // The retained hydrated lease belongs to the pipeline invocation and is
      // intentionally not available to this test process as a forged handle.
      fs.rmSync(path.join(root, '.scout', 'scan-lease.json'), { force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-success work requires a durable mutation receipt and remains under the live scan fence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-receipted-post-success-'));
  let hookCalls = 0;
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      finalize: async () => ({
        schemaVersion: 1,
        result: { ok: true },
        mutationReceipt: {
          schemaVersion: 1,
          id: 'scan-tracker-report',
          digest: 'd'.repeat(64),
        },
      }),
      async postTerminalSuccess({ lease, manifest, mutationReceipt }) {
        hookCalls += 1;
        const current = readScanLease(root);
        assert.equal(current.leaseId, lease.leaseId);
        assert.equal(current.generation, lease.generation);
        assert.equal(manifest.outcome, 'complete');
        assert.deepEqual(manifest.receipts, [{
          sequence: 8,
          stageId: 'finalise',
          reference: { kind: 'mutation', id: 'scan-tracker-report' },
          digest: 'd'.repeat(64),
        }]);
        assert.equal(mutationReceipt.digest, 'd'.repeat(64));
      },
    });

    assert.equal(result.outcome, 'complete');
    assert.equal(hookCalls, 1);
    assert.deepEqual(result.failures, []);
    assert.equal(readScanLease(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pipeline accepts a coordinator-journalled receipt without projecting a duplicate mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-coordinated-receipt-'));
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', '2026-07-28.md'), '# Report\n\n## Headline\n\nBefore.\n');
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      finalize: async ({ run, lease }) => {
        const plan = prepareMutation({ handle: run, lease }, {
          id: 'coordinated-report',
          schemaVersion: 1,
          files: [{ kind: 'report', key: 'report:2026-07-28' }],
        }, {
          'report:2026-07-28': scanReportRecipe({
            date: '2026-07-28',
            degraded: false,
            coverage: [],
            actions: [],
            checks: [],
            keeperCount: 0,
            discarded: {},
            nearMisses: [],
            errors: [],
            runs: [],
          }),
        });
        return {
          schemaVersion: 1,
          result: { ok: true },
          mutationReceipt: applyPreparedMutation(plan, lease),
        };
      },
    });

    assert.equal(result.outcome, 'complete');
    const receipts = replayRunJournal(openRunJournal(root, result.runId).file)
      .filter((event) => event.type === 'mutation.receipted');
    assert.equal(receipts.length, 1);
    assert.equal(result.manifest.receipts.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-success backup is not attempted without receipt evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-unreceipted-post-success-'));
  let hookCalls = 0;
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      finalize: async () => ({ ok: true }),
      postTerminalSuccess: async () => { hookCalls += 1; },
    });

    assert.equal(result.outcome, 'complete');
    assert.equal(hookCalls, 0);
    assert.deepEqual(result.failures, [{
      code: 'backup-pending',
      stage: 'post-success',
      reason: 'mutation-receipt-missing',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-success backup failure preserves the successful scan and reports pending backup state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-failed-post-success-'));
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      finalize: async () => ({
        schemaVersion: 1,
        result: { ok: true },
        mutationReceipt: {
          schemaVersion: 1,
          id: 'scan-tracker-report',
          digest: 'e'.repeat(64),
        },
      }),
      postTerminalSuccess: async () => {
        throw new Error('PRIVATE_BACKUP_TRANSPORT_FAILURE');
      },
    });

    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.failures, [{
      code: 'backup-pending',
      stage: 'post-success',
      reason: 'backup-failed',
    }]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BACKUP_TRANSPORT_FAILURE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed mutation receipt preserves scan success and reports backup pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-malformed-receipt-'));
  let hookCalls = 0;
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      finalize: async () => ({
        schemaVersion: 1,
        result: { ok: true },
        mutationReceipt: {
          schemaVersion: 1,
          id: 'scan-tracker-report',
          digest: 'not-a-sha256-digest',
        },
      }),
      postTerminalSuccess: async () => {
        hookCalls += 1;
        return { status: 'complete' };
      },
    });

    assert.equal(result.outcome, 'complete');
    assert.equal(hookCalls, 0);
    assert.deepEqual(result.failures, [{
      code: 'backup-pending',
      stage: 'post-success',
      reason: 'mutation-receipt-invalid',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit pending post-success result preserves scan success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-explicit-backup-pending-'));
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      finalize: async () => ({
        schemaVersion: 1,
        result: { ok: true },
        mutationReceipt: {
          schemaVersion: 1,
          id: 'scan-tracker-report',
          digest: 'a'.repeat(64),
        },
      }),
      postTerminalSuccess: async () => ({
        status: 'pending',
        reason: 'backup-offline',
      }),
    });

    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.failures, [{
      code: 'backup-pending',
      stage: 'post-success',
      reason: 'backup-offline',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit partial post-success result preserves scan success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-explicit-backup-partial-'));
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      finalize: async () => ({
        schemaVersion: 1,
        result: { ok: true },
        mutationReceipt: {
          schemaVersion: 1,
          id: 'scan-tracker-report',
          digest: 'b'.repeat(64),
        },
      }),
      postTerminalSuccess: async () => ({
        status: 'partial',
        reason: 'backup-needs-attention',
      }),
    });

    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.failures, [{
      code: 'backup-partial',
      stage: 'post-success',
      reason: 'backup-needs-attention',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider health preflight durably abandons a blocked run before any scan work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-health-blocked-'));
  const calls = [];
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: Object.fromEntries(DURABLE_STAGES.map((stageId) => [stageId, async () => {
        calls.push(stageId);
        return { stageId, stableIds: [] };
      }])),
      async healthPreflight(context) {
        calls.push('health');
        assert.equal(context.root, root);
        assert.equal(context.provider, 'codex');
        assert.equal(context.purpose, 'manual-discovery');
        assert.equal(context.lease.runId, context.runId);
        return {
          ok: false,
          state: 'sign-in-required',
          reason: 'remote-auth-failure',
        };
      },
      async prepare() { calls.push('prepare'); },
      async finalize() { calls.push('finalize'); },
      async postTerminalSuccess() { calls.push('post-success'); },
      queue: {
        compatibility: {
          profileFingerprint: 'b'.repeat(64),
          configFingerprint: 'c'.repeat(64),
          schemaVersion: 1,
        },
        async run() { throw new Error('queue drain should have no work'); },
        async cover() { calls.push('queue-cover'); },
      },
    });

    assert.equal(result.outcome, 'abandoned');
    assert.deepEqual(result.failures, [{
      code: 'provider-health-blocked',
      stage: 'initialise',
      reason: 'sign-in-required',
    }]);
    assert.deepEqual(calls, ['health']);
    const events = replayRunJournal(openRunJournal(root, result.runId).file);
    assert.deepEqual(events.map((event) => event.type), [
      'run.started',
      'run.failure-recorded',
      'run.completed',
    ]);
    assert.deepEqual(events[1].payload, {
      schemaVersion: 1,
      code: 'provider-health-blocked',
      reason: 'sign-in-required',
    });
    assert.deepEqual(events[2].payload, {
      schemaVersion: 1,
      outcome: 'abandoned',
    });
    assert.equal(readScanLease(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a provider health preflight exception records a bounded blocked run and releases authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-health-preflight-error-'));
  try {
    const result = await runScanPipeline({
      root,
      compatibility: RECOVERY_COMPATIBILITY,
      stages: durableStageHarness(new Map()),
      async healthPreflight() {
        throw new Error('PRIVATE_PROVIDER_HEALTH_STORAGE_DETAIL');
      },
    });

    assert.equal(result.outcome, 'abandoned');
    assert.deepEqual(result.failures, [{
      code: 'provider-health-blocked',
      stage: 'initialise',
      reason: 'provider-error',
    }]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_HEALTH_STORAGE_DETAIL/);
    const events = replayRunJournal(openRunJournal(root, result.runId).file);
    assert.deepEqual(events.map((event) => event.type), [
      'run.started',
      'run.failure-recorded',
      'run.completed',
    ]);
    assert.equal(readScanLease(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
