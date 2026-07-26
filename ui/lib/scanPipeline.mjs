import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { serializeTracker } from './tracker.mjs';
import { workspacePaths } from './workspace.mjs';
import {
  advertMateriallyChanged, invalidateJobIdentity, jobIdentity, mergeSourceReferences, sameUnderlyingJob, sourceReferencesOf,
} from './jobIdentity.mjs';
import { isVerifiable } from './statusGroups.mjs';
import { canonicaliseObservations } from './vacancyCanonical.mjs';
import { createDiscoveryFunnel, advanceDiscoveryFunnel, assertDiscoveryFunnel } from './discoveryFunnel.mjs';
import { filterVacancies } from './vacancyFilter.mjs';
import { normaliseObservation } from './vacancyObservation.mjs';
import { rankVacancies } from './vacancyRank.mjs';
import { selectVacancies } from './vacancySelect.mjs';
export { filterVacancies } from './vacancyFilter.mjs';

const EMPTY_DISCARDED = Object.freeze({ hard_exclusion: 0, mandatory_unmet: 0, below_threshold: 0, provider_discarded: 0 });
const REVIEW_REASON_LIMIT = 3;

function boundedText(value, maximum = 220) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maximum);
}

function safeSourceUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.href.length <= 2048 ? parsed.href : null;
  } catch { return null; }
}

export const SCAN_ASSESSMENT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    assessments: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          candidateId: { type: 'string' }, categoryId: { type: ['string', 'null'] }, summary: { type: 'string' },
          hardExclusionMatches: { type: 'array', items: { type: 'string' } },
          mandatoryRequirements: {
            type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: {
                requirement: { type: 'string' }, advertEvidence: { type: 'string' },
                advertEvidenceId: { type: 'string' },
                status: { type: 'string', enum: ['met', 'unmet', 'unknown'] }, profileEvidence: { type: ['string', 'null'] },
              }, required: ['requirement', 'advertEvidence', 'advertEvidenceId', 'status', 'profileEvidence'],
            },
          },
          dimensions: {
            type: 'array', minItems: 1, items: {
              type: 'object', additionalProperties: false,
              properties: { name: { type: 'string' }, score: { type: 'number' }, maximum: { type: 'number' }, evidence: { type: 'string' } },
              required: ['name', 'score', 'maximum', 'evidence'],
            },
          },
          recommendation: { type: 'string', enum: ['keep', 'discard'] },
        }, required: ['candidateId', 'categoryId', 'summary', 'hardExclusionMatches', 'mandatoryRequirements', 'dimensions', 'recommendation'],
      },
    },
  }, required: ['assessments'],
});

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'opportunity';
}

function mandatorySignals(description, requirements) {
  const sourceRequirements = String(requirements || '').split(/(?:\r?\n|;\s*)/)
    .map((text) => text.trim())
    .filter((text) => text && !/\b(?:benefits?|perks?|stock options?|compensation|salary|remote-friendly)\b/i.test(text));
  const explicitLanguage = String(description || '').split(/(?:\r?\n|[.;]\s+)/)
    .map((text) => text.trim()).filter((text) => text && /\b(?:required|essential|must|mandatory|non-negotiable)\b/i.test(text));
  return [...new Set([...sourceRequirements, ...explicitLanguage])]
    .slice(0, 12).map((text, index) => ({ id: `mandatory-${String(index + 1).padStart(2, '0')}`, text: text.slice(0, 300) }));
}

function boundedContributions(contributions, positive) {
  return (contributions || []).filter((item) => (positive ? Number(item?.score) > 0 : Number(item?.score) < 0))
    .sort((left, right) => Math.abs(Number(right.score)) - Math.abs(Number(left.score))).slice(0, 3)
    .map((item) => ({ code: boundedText(item.profileRuleId, 100), score: Number(item.score) }));
}

function boundedExplanation(candidate, { assessmentStatus, selectionReason = null, deterministicExclusion = null } = {}) {
  const preRank = candidate?.preRank || { score: candidate?.preRankScore, positive: boundedContributions(candidate?.contributions, true), negative: boundedContributions(candidate?.contributions, false) };
  const compact = (items) => (items || []).map((item) => typeof item === 'string' ? boundedText(item, 100) : { code: boundedText(item?.code, 100), score: Number(item?.score) }).slice(0, 3);
  return {
    vacancy_id: boundedText(candidate?.vacancyId || candidate?.candidateId, 160),
    pre_rank: { score: Number.isFinite(Number(preRank?.score)) ? Number(preRank.score) : null, positive: compact(preRank?.positive), negative: compact(preRank?.negative) },
    selection_reason: selectionReason ? boundedText(selectionReason, 100) : null,
    deterministic_exclusion: deterministicExclusion ? boundedText(deterministicExclusion, 100) : null,
    assessment_status: assessmentStatus, source: boundedText(candidate?.source, 80), sourceUrl: safeSourceUrl(candidate?.url),
  };
}

function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceReferences(vacancy) {
  return (vacancy?.sourceReferences || []).map((reference) => ({
    source: reference.source || reference.sourceName || '',
    providerId: reference.providerId || reference.sourceRecordId || '',
    url: reference.url || reference.sourceUrl || '',
  }));
}

function assessmentVacancy(vacancy) {
  const observation = vacancy?.observations?.[0] || {};
  const references = sourceReferences(vacancy);
  const url = vacancy?.canonicalUrl || observation.sourceUrl || references[0]?.url || '';
  return {
    ...vacancy,
    company: valueOf(vacancy?.employer) || '',
    role: valueOf(vacancy?.title) || '',
    url,
    location: valueOf(vacancy?.location) || '',
    workingType: valueOf(vacancy?.workingPattern) || '',
    salary: valueOf(vacancy?.compensation) || null,
    postedDate: vacancy?.postedAt || null,
    source: observation.source || references[0]?.source || '',
    providerId: observation.sourceRecordId || references[0]?.providerId || '',
    sourceReferences: references,
    sources: [...new Set([url, ...references.map((reference) => reference.url)].filter(Boolean))],
    duplicateCount: Math.max(1, Number(vacancy?.observations?.length || 1)),
    tags: [],
    requirements: '',
  };
}

function candidateFromSelected(vacancy, index) {
  const candidate = assessmentVacancy(vacancy);
  return {
    ...candidate,
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    description: String(candidate.description || '').slice(0, 1200),
    mandatorySignals: mandatorySignals(candidate.description, candidate.requirements),
  };
}

export function assessmentCandidatesForSelection(selected) {
  return (selected || []).map(candidateFromSelected);
}

function observationInputs(sources) {
  return Object.entries(sources || {}).sort(([left], [right]) => compareText(left, right)).flatMap(([sourceName, source]) => (
    [...(source?.jobs || [])].map((job) => normaliseObservation(job, {
      sourceName: job?.source || sourceName,
      fetchedAt: source?.fetchedAt || source?.generatedAt || null,
      laneId: job?.laneId || job?.source || source?.laneId || sourceName,
    })).filter(Boolean)
  ));
}

// The deterministic discovery boundary deliberately evaluates every
// normalised, canonical vacancy before it applies the bounded assessment set.
// Candidate identifiers are generated only after selection, so a source's
// response order cannot leak into provider-facing identities.
export function prepareRankedDiscovery({
  sources, profile, tracker = { opportunities: [] }, runId = '', limit = DEFAULT_CANDIDATE_LIMIT,
} = {}) {
  if (!profile || profile.status !== 'published') throw new Error('ranked discovery requires a published search profile');
  const initialFunnel = createDiscoveryFunnel(sources);
  const observations = observationInputs(sources);
  const canonical = canonicaliseObservations(observations);
  const vacancies = canonical.vacancies.map(assessmentVacancy);
  const filtered = filterVacancies(vacancies, profile);
  const ranked = rankVacancies(filtered.eligible, profile, tracker?.opportunities || []);
  const selection = selectVacancies(ranked, { limit, seed: runId });
  const funnel = assertDiscoveryFunnel(advanceDiscoveryFunnel(initialFunnel, 'selection', {
    parsed: initialFunnel.sourceRecords - initialFunnel.failedSourceRecords,
    normalised: observations.length,
    duplicateObservations: canonical.duplicateObservations,
    uniqueVacancies: vacancies.length,
    deterministicallyExcluded: vacancies.length - filtered.eligible.length,
    eligible: filtered.eligible.length,
    ranked: ranked.length,
    aboveThreshold: ranked.length - selection.belowCutoff.length,
    selected: selection.selected.length,
  }));
  const vacancyById = new Map(vacancies.map((vacancy) => [String(vacancy.vacancyId || vacancy.canonicalUrl), vacancy]));
  const exclusions = filtered.excluded.map((item) => {
    const vacancy = vacancyById.get(String(item.vacancyId));
    return { ...item, source: vacancy?.source || '', url: vacancy?.url || vacancy?.canonicalUrl || '' };
  });
  return {
    observations,
    vacancies,
    exclusions,
    ranked,
    selection,
    funnel,
    candidates: assessmentCandidatesForSelection(selection.selected),
  };
}

// Deprecated: retained only for beta.22 compatibility consumers. Ranked
// discovery uses filterVacancies() and never performs whole-prose matching.
export function applyHardExclusions(candidates, exclusions = []) {
  const terms = (exclusions || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  const kept = [];
  const excluded = [];
  for (const candidate of candidates || []) {
    const matches = terms.filter((term) => String(candidate?.description || '').toLowerCase().includes(term));
    if (matches.length) excluded.push({ ...candidate, hardExclusionMatches: matches });
    else kept.push(candidate);
  }
  return { candidates: kept, excluded };
}

export const DEFAULT_CANDIDATE_LIMIT = 60;

// Fields the assessment prompt actually reads. Everything else stays in the
// local scan bundle: `requirements` and `sourceReferences` duplicate content
// the model already receives, and `providerId`/`duplicateCount` are bookkeeping.
const PROMPT_CANDIDATE_FIELDS = [
  'candidateId', 'company', 'role', 'url', 'location', 'salary', 'workingType',
  'postedDate', 'source', 'tags', 'description', 'mandatorySignals',
];

// `second-pass` previously changed nothing but the artifact label: the second
// provider re-collected every source and re-scored every candidate, so two
// daily jobs cost roughly double for largely the same work. A verification pass
// should re-examine what the primary scan actually decided today — the roles it
// kept, and the ones close enough to the threshold that a second opinion could
// change the outcome. Falls back to the full set when there is nothing from
// today to verify, so a standalone second-pass run still does useful work.
export function verificationCandidates(candidates, tracker, today, policy = {}) {
  const checkScore = Number(policy.checkScore ?? 55);
  const recentUrls = new Set();
  for (const entry of tracker?.opportunities || []) {
    const recent = entry.lastChecked === today || entry.firstSeen === today;
    const worthVerifying = recent && isVerifiable(entry.status)
      && (typeof entry.score !== 'number' || entry.score >= checkScore - 10);
    if (!worthVerifying) continue;
    for (const url of entry.sources || []) if (url) recentUrls.add(String(url));
  }
  if (!recentUrls.size) return { candidates, verified: false };
  const selected = candidates.filter((candidate) => (candidate.sources || [candidate.url])
    .some((url) => recentUrls.has(String(url))));
  return selected.length ? { candidates: selected, verified: true } : { candidates, verified: false };
}

// Existing untriaged jobs must not live in the inbox forever merely because a
// later scan did not rediscover them. Recheck only `new` entries; every status
// set by the user is deliberately outside this maintenance path.
export function inboxRecheckCandidates(tracker, incomingCandidates = []) {
  const checkable = [];
  const missingSource = [];
  for (const entry of tracker?.opportunities || []) {
    if (entry.status !== 'new') continue;
    if (incomingCandidates.some((candidate) => sameUnderlyingJob(entry, candidate))) continue;
    const url = (entry.sources || []).map(safeSourceUrl).find(Boolean);
    const candidate = { _inboxRecheck: true, _trackerId: entry.id, url };
    if (url) checkable.push(candidate);
    else missingSource.push({ ...candidate, liveness: { state: 'gone', reason: 'no individual advert URL is stored' } });
  }
  return { checkable, missingSource };
}

function archiveStaleInboxEntries(tracker, entries, date) {
  const reasons = new Map(entries.map((item) => [item._trackerId, item.liveness?.reason || 'advert is no longer live']));
  let archived = 0;
  for (const entry of tracker.opportunities || []) {
    const reason = reasons.get(entry.id);
    if (entry.status !== 'new' || !reason) continue;
    entry.status = 'ignore';
    entry.tags = [...new Set([...(entry.tags || []), 'Advert unavailable'])];
    const note = `[${date}] Removed from Jobs automatically: ${reason}.`;
    if (!String(entry.notes || '').includes(note)) entry.notes = entry.notes ? `${entry.notes}\n${note}` : note;
    entry.lastChecked = date;
    archived += 1;
  }
  return archived;
}

export function promptCandidate(candidate) {
  return Object.fromEntries(PROMPT_CANDIDATE_FIELDS
    .filter((field) => candidate[field] !== undefined)
    .map((field) => [field, candidate[field]]));
}

function normaliseJob(job) {
  const company = String(job?.company || '').trim();
  const role = String(job?.title || job?.role || '').trim();
  const url = String(job?.url || '').trim();
  if (!company || !role || !/^https?:\/\//i.test(url)) return null;
  return {
    company, role, url, location: String(job?.location || ''), salary: job?.salary || null,
    workingType: String(job?.workingType || ''), postedDate: job?.postedDate || null,
    source: String(job?.source || ''), providerId: String(job?.providerId || ''),
    description: String(job?.description || ''), requirements: String(job?.requirements || ''),
    tags: Array.isArray(job?.tags) ? job.tags : [], sourceReferences: sourceReferencesOf(job), duplicateCount: 1,
  };
}

function absorbDuplicate(existing, incoming) {
  existing.sourceReferences = mergeSourceReferences(existing, incoming);
  existing.duplicateCount += 1;
  existing.tags = [...new Set([...existing.tags, ...incoming.tags])];
  if (incoming.description.length > existing.description.length) existing.description = incoming.description;
  if (!existing.salary && incoming.salary) existing.salary = incoming.salary;
  invalidateJobIdentity(existing);
}

// Candidates were previously filled in source order until the cap was reached,
// so once it filled every remaining source contributed nothing and the loss was
// never recorded. Each source now gets a guaranteed share of the budget first,
// leftover capacity is shared among the sources that still have jobs, and what
// could not fit is reported so a truncated scan is visible rather than silent.
export function compactCandidates(sources, maximum = DEFAULT_CANDIDATE_LIMIT) {
  const pools = new Map();
  // sameUnderlyingJob only matches jobs that share a URL or a normalised
  // company, so comparing every new job against every earlier one is wasted
  // work. Bucketing keeps the raised candidate limit from making collection
  // quadratic over a few hundred postings.
  const byCompany = new Map();
  const byUrl = new Map();
  for (const [name, source] of Object.entries(sources || {})) {
    const pool = [];
    for (const job of source?.jobs || []) {
      const incoming = normaliseJob(job);
      if (!incoming) continue;
      const key = jobIdentity(incoming).company || '';
      const bucket = byCompany.get(key) || [];
      const duplicate = byUrl.get(incoming.url)
        || bucket.find((candidate) => sameUnderlyingJob(candidate, incoming));
      if (duplicate) {
        absorbDuplicate(duplicate, incoming);
        for (const reference of duplicate.sourceReferences) if (reference.url) byUrl.set(reference.url, duplicate);
        continue;
      }
      bucket.push(incoming);
      byCompany.set(key, bucket);
      for (const reference of incoming.sourceReferences) if (reference.url) byUrl.set(reference.url, incoming);
      byUrl.set(incoming.url, incoming);
      pool.push(incoming);
    }
    if (pool.length) pools.set(name, pool);
  }

  const selected = [];
  const dropped = {};
  const share = pools.size ? Math.max(1, Math.floor(maximum / pools.size)) : 0;
  for (const [name, pool] of pools) selected.push(...pool.slice(0, share).map((job) => ({ name, job })));
  // Round-robin the remainder so no single large source consumes it all.
  for (let index = share; selected.length < maximum; index += 1) {
    let added = false;
    for (const [name, pool] of pools) {
      if (selected.length >= maximum) break;
      if (index >= pool.length) continue;
      selected.push({ name, job: pool[index] });
      added = true;
    }
    if (!added) break;
  }
  const takenByName = new Map();
  for (const { name } of selected) takenByName.set(name, (takenByName.get(name) || 0) + 1);
  for (const [name, pool] of pools) {
    const missed = pool.length - (takenByName.get(name) || 0);
    if (missed > 0) dropped[name] = missed;
  }

  const candidates = selected.map(({ job }, index) => ({
    ...job,
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    description: job.description.slice(0, 1200),
    sources: [...new Set(job.sourceReferences.map((reference) => reference.url).filter(Boolean))],
    mandatorySignals: mandatorySignals(job.description, job.requirements),
  }));
  return {
    candidates,
    dropped: { perSource: dropped, total: Object.values(dropped).reduce((sum, count) => sum + count, 0) },
  };
}

export function validateAssessments(value, candidates) {
  if (!value || !Array.isArray(value.assessments)) throw new Error('scan assessment must contain an assessments array');
  const known = new Set(candidates.map((item) => item.candidateId));
  const seen = new Set();
  for (const item of value.assessments) {
    if (!known.has(item.candidateId) || seen.has(item.candidateId)) throw new Error(`invalid or duplicate candidate assessment: ${item.candidateId}`);
    seen.add(item.candidateId);
    if (!Array.isArray(item.dimensions) || !item.dimensions.length) throw new Error(`assessment lacks score dimensions: ${item.candidateId}`);
    const maximum = item.dimensions.reduce((sum, dimension) => sum + Number(dimension.maximum), 0);
    if (Math.abs(maximum - 100) > 0.001) throw new Error(`assessment dimensions must total 100: ${item.candidateId}`);
    for (const dimension of item.dimensions) {
      if (!Number.isFinite(dimension.score) || !Number.isFinite(dimension.maximum)
          || dimension.score < 0 || dimension.score > dimension.maximum) throw new Error(`invalid score dimension: ${item.candidateId}`);
    }
    const candidate = candidates.find((entry) => entry.candidateId === item.candidateId);
    const knownSignals = new Set((candidate?.mandatorySignals || []).map((signal) => signal.id));
    for (const requirement of item.mandatoryRequirements || []) {
      if (!requirement.requirement || !requirement.advertEvidence || !requirement.advertEvidenceId) throw new Error(`mandatory requirement lacks advert evidence: ${item.candidateId}`);
      if (!knownSignals.has(requirement.advertEvidenceId) && !/^provider-[a-z0-9-]+$/i.test(requirement.advertEvidenceId)) {
        throw new Error(`mandatory requirement cites unknown advert evidence: ${item.candidateId}`);
      }
      if (requirement.status === 'met' && !String(requirement.profileEvidence || '').trim()) throw new Error(`met requirement lacks profile evidence: ${item.candidateId}`);
    }
    const coveredSignals = new Set((item.mandatoryRequirements || []).map((requirement) => requirement.advertEvidenceId));
    const missingSignals = [...knownSignals].filter((id) => !coveredSignals.has(id));
    if (missingSignals.length) throw new Error(`assessment omitted mandatory advert evidence ${missingSignals.join(', ')}: ${item.candidateId}`);
  }
  if (seen.size !== candidates.length) throw new Error(`scan assessment covered ${seen.size} of ${candidates.length} candidates`);
  return value;
}

export function gateAssessment(assessment, policy) {
  const actionScore = Number(policy?.actionScore ?? 70);
  const checkScore = Number(policy?.checkScore ?? 55);
  const total = Math.round(assessment.dimensions.reduce((sum, item) => sum + Number(item.score), 0) * 100) / 100;
  const unmet = (assessment.mandatoryRequirements || []).filter((item) => item.status === 'unmet');
  const unknown = (assessment.mandatoryRequirements || []).filter((item) => item.status === 'unknown');
  const excluded = (assessment.hardExclusionMatches || []).length > 0;
  if (assessment.recommendation === 'discard' || excluded || unmet.length) {
    return { eligibility: 'ineligible', score: Math.min(total, checkScore - 1), keep: false, reasons: [...assessment.hardExclusionMatches, ...unmet.map((item) => item.requirement)] };
  }
  if (unknown.length) {
    return { eligibility: 'check', score: Math.min(total, actionScore - 1), keep: total >= checkScore, reasons: unknown.map((item) => item.requirement) };
  }
  return { eligibility: total >= actionScore ? 'eligible' : total >= checkScore ? 'check' : 'below-threshold', score: total, keep: total >= checkScore, reasons: [] };
}

function sourceHealth(sources) {
  return Object.fromEntries(Object.entries(sources || {}).map(([name, value]) => [name, {
    status: value.status || 'unavailable', count: Number.isFinite(Number(value.count)) ? Number(value.count) : null,
    reason: value.reason || null, configured: value.configured !== false,
  }]));
}

function mergeTracker(existing, candidates, assessments, policy, date) {
  const byId = new Map(existing.opportunities.map((entry) => [entry.id, entry]));
  const discarded = { ...EMPTY_DISCARDED };
  const reviewed = [];
  let keepersAdded = 0;
  let keepersUpdated = 0;
  for (const assessment of assessments) {
    const candidate = candidates.find((item) => item.candidateId === assessment.candidateId);
    if (!candidate) continue;
    const gate = gateAssessment(assessment, policy);
    let outcome = 'kept';
    if (!gate.keep) {
      if ((assessment.hardExclusionMatches || []).length) outcome = 'hard_exclusion';
      else if ((assessment.mandatoryRequirements || []).some((item) => item.status === 'unmet')) outcome = 'mandatory_unmet';
      else if (assessment.recommendation === 'discard') outcome = 'provider_discarded';
      else outcome = 'below_threshold';
      discarded[outcome] += 1;
    }
    const reasons = gate.reasons.length
      ? gate.reasons
      : outcome === 'provider_discarded' ? [assessment.summary]
        : outcome === 'below_threshold' ? ['Below the configured check threshold'] : [];
    reviewed.push({
      company: boundedText(candidate.company, 120), role: boundedText(candidate.role, 160),
      source: boundedText(candidate.source, 80), sourceUrl: safeSourceUrl(candidate.url),
      categoryId: boundedText(assessment.categoryId, 80) || null,
      outcome, score: gate.score,
      reasons: reasons.map((reason) => boundedText(reason)).filter(Boolean).slice(0, REVIEW_REASON_LIMIT),
    });
    if (!gate.keep) {
      continue;
    }
    const baseId = `${slug(candidate.company)}-${slug(candidate.role)}-${date.slice(0, 7)}`;
    const previous = existing.opportunities.find((entry) => sameUnderlyingJob(entry, candidate));
    let id = previous?.id || baseId;
    for (let suffix = 2; !previous && byId.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    const changedAdvert = Boolean(previous && advertMateriallyChanged(previous, candidate));
    const references = mergeSourceReferences(previous || {}, candidate);
    const urls = references.map((reference) => reference.url).filter(Boolean);
    const generated = {
      id, company: candidate.company, role: candidate.role, location: candidate.location || previous?.location || '', score: gate.score,
      scoreBreakdown: Object.fromEntries(assessment.dimensions.map((item) => [item.name, item.score])),
      eligibility: { status: gate.eligibility, reasons: gate.reasons },
      mandatoryRequirements: assessment.mandatoryRequirements,
      status: previous?.status || 'new', category: assessment.categoryId || previous?.category || null,
      tags: [...new Set([...(previous?.tags || []), ...(candidate.tags || []), ...(gate.eligibility === 'check' ? ['Check mandatory requirement'] : []), ...(changedAdvert ? ['Updated advert — review'] : [])])],
      sources: [...new Set([...(previous?.sources || []), ...urls])], sourceReferences: references,
      jobIdentity: jobIdentity(candidate),
      notes: previous && Object.hasOwn(previous, 'notes') ? previous.notes : assessment.summary,
      lastChecked: date, foundVia: candidate.source, contacts: previous?.contacts || [], log: previous?.log || [],
      ...(changedAdvert ? { advertUpdate: { detectedAt: date, previousFingerprint: previous.jobIdentity?.advertFingerprint || '', currentFingerprint: jobIdentity(candidate).advertFingerprint } } : {}),
    };
    if (previous) { Object.assign(previous, generated); keepersUpdated += 1; }
    else { existing.opportunities.push(generated); byId.set(generated.id, generated); keepersAdded += 1; }
  }
  existing.updated = date;
  return { tracker: existing, keepersAdded, keepersUpdated, discarded, reviewed };
}

function reportText({ date, degraded, source_health, kept, discarded, reviewed, errors }) {
  const coverage = Object.entries(source_health).map(([name, value]) => `- ${name}: ${value.configured === false ? 'not configured' : value.status} (${value.count ?? 'unknown'})${value.reason ? ` — ${value.reason}` : ''}`).join('\n');
  const actions = kept.filter((item) => item.eligibility?.status === 'eligible').map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${item.sources?.[0] || ''}`).join('\n') || '- None.';
  const checks = kept.filter((item) => item.eligibility?.status === 'check').map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${(item.eligibility.reasons || []).join('; ')}`).join('\n') || '- None.';
  const nearMisses = (reviewed || []).filter((item) => item.outcome !== 'kept' && item.outcome !== 'hard_exclusion')
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 5)
    .map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${item.reasons.join('; ') || item.outcome}${item.sourceUrl ? ` — ${item.sourceUrl}` : ''}`).join('\n') || '- None.';
  return `# Scout report — ${date}\n\n## Headline\n\n${degraded ? 'Coverage was degraded; this is not evidence that no suitable roles exist.' : 'Configured sources completed successfully.'}\n\n${coverage}\n\n## Action today\n\n${actions}\n\n## One check from unlocking\n\n${checks}\n\n## Follow-ups due\n\n- Review existing tracker follow-ups in Scout.\n\n## Changes since last scan\n\n- ${kept.length} current keeper(s) in the tracker.\n\n## Discarded\n\n${Object.entries(discarded).map(([name, count]) => `- ${name}: ${count}`).join('\n')}\n\n### Closest reviewed roles not kept\n\n${nearMisses}\n\nThe full sanitised review is available from Scout's latest scan result.\n\n## Verdicts\n\n${errors.length ? errors.map((error) => `- Error: ${error}`).join('\n') : '- No applications or outreach were sent.'}\n`;
}

function atomicWrite(file, content) {
  atomicWriteFile(file, content);
}

export function validateWrittenScanArtifacts(root, expectedRun) {
  const paths = workspacePaths(root);
  const tracker = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  if (!Array.isArray(tracker.opportunities)) throw new Error('scan tracker artifact is invalid');
  const report = fs.readFileSync(path.join(paths.reports, `${expectedRun.timestamp.slice(0, 10)}.md`), 'utf8');
  for (const heading of ['Headline', 'Action today', 'One check from unlocking', 'Follow-ups due', 'Changes since last scan', 'Discarded', 'Verdicts']) {
    if (!report.includes(`## ${heading}`)) throw new Error(`scan report is missing ${heading}`);
  }
  const lines = fs.readFileSync(paths.scanRuns, 'utf8').trim().split(/\r?\n/);
  const run = JSON.parse(lines.at(-1));
  for (const field of ['schemaVersion', 'timestamp', 'agent', 'mode', 'degraded', 'sources_checked', 'candidates_found', 'keepers_added', 'discarded', 'errors', 'source_health']) {
    if (!Object.hasOwn(run, field)) throw new Error(`scan run is missing ${field}`);
  }
  if (Number(run.schemaVersion) >= 3 && !Array.isArray(run.reviewed)) throw new Error('scan run is missing reviewed audit data');
  if (run.timestamp !== expectedRun.timestamp || run.agent !== expectedRun.agent || run.mode !== expectedRun.mode) throw new Error('scan run record does not match the completed request');
  return { tracker, report, run };
}

export function writeScanArtifacts(root, {
  provider, mode, sources, queries = [], candidates, assessmentResult, policy, startedAt,
  error = null, skipped = false, dropped = { perSource: {}, total: 0 }, hardExcluded = [], closedAdverts = [], exclusions = [],
  livenessSummary = { checked: 0, gone: 0, unverified: 0 }, verificationScoped = false,
  staleInboxEntries = [], inboxRechecked = 0, funnel = null, selection = [], discoveryEngine = 'legacy-discovery', profileId = null,
}) {
  const paths = workspacePaths(root);
  const timestamp = new Date().toISOString();
  const date = timestamp.slice(0, 10);
  const health = sourceHealth(sources);
  const configuredSources = Object.values(health).filter((item) => item.configured !== false);
  const configuredFailures = Object.values(health).filter((item) => item.configured !== false && item.status !== 'healthy');
  const errors = [...(error ? [error] : []), ...(configuredSources.length ? [] : ['no job sources are configured'])];
  const degraded = configuredFailures.length > 0 || errors.length > 0;
  const existing = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  const merged = assessmentResult
    ? mergeTracker(existing, candidates, assessmentResult.assessments, policy, date)
    : { tracker: existing, keepersAdded: 0, keepersUpdated: 0, discarded: { ...EMPTY_DISCARDED }, reviewed: [] };
  const inboxArchived = archiveStaleInboxEntries(merged.tracker, staleInboxEntries, date);
  const reconciledFunnel = funnel && error ? { ...funnel, assessed: Number(assessmentResult?.assessments?.length || 0), assessmentFailed: Math.max(0, Number(funnel.selected || candidates.length) - Number(assessmentResult?.assessments?.length || 0)) } : funnel;
  const assessedIds = new Set((assessmentResult?.assessments || []).map((item) => item.candidateId));
  const selectionByVacancy = new Map((selection || []).map((item) => [String(item?.vacancyId || ''), item]));
  const explanations = [
    ...candidates.map((candidate) => boundedExplanation(candidate, { assessmentStatus: assessedIds.has(candidate.candidateId) ? 'assessed' : 'assessment-failed', selectionReason: selectionByVacancy.get(String(candidate.vacancyId || ''))?.reason || candidate.selectionReason || 'selected' })),
    ...exclusions.map((item) => boundedExplanation(item, { assessmentStatus: 'not-selected', deterministicExclusion: item.code || item.exclusionCode })),
  ].slice(0, 180);
  const selection_summary = reconciledFunnel ? { selected: Number(reconciledFunnel.selected || 0), assessed: Number(reconciledFunnel.assessed || 0), assessmentFailed: Number(reconciledFunnel.assessmentFailed || 0) } : null;
  const run = {
    schemaVersion: 4, timestamp, started_at: startedAt, agent: provider, mode, degraded, skipped,
    sources_checked: Object.entries(health).filter(([, item]) => item.configured !== false).map(([name]) => name),
    queries_checked: [...queries], candidates_found: candidates.length, keepers_added: merged.keepersAdded,
    duplicates_collapsed: candidates.reduce((total, candidate) => total + Math.max(0, Number(candidate.duplicateCount || 1) - 1), 0),
    keepers_updated: merged.keepersUpdated,
    discarded: {
      ...merged.discarded,
      // Applied deterministically before the assessment turn rather than by
      // the provider, so they are counted here instead.
      hard_exclusion: merged.discarded.hard_exclusion + hardExcluded.length,
      advert_closed: closedAdverts.length,
    },
    candidates_dropped: dropped.total, candidates_dropped_by_source: dropped.perSource,
    adverts_checked: livenessSummary.checked, adverts_closed: livenessSummary.gone,
    adverts_unverified: livenessSummary.unverified, verification_scoped: verificationScoped,
    inbox_rechecked: inboxRechecked, inbox_archived: inboxArchived,
    profile_id: profileId, discovery_engine: discoveryEngine,
    ...(reconciledFunnel ? { funnel: reconciledFunnel } : {}),
    ...(selection_summary ? { selection_summary } : {}),
    ...(selection.length ? { selection } : {}),
    ...(explanations.length ? { explanations } : {}),
    reviewed: merged.reviewed, errors, source_health: health,
  };
  const earlierRuns = fs.existsSync(paths.scanRuns)
    ? fs.readFileSync(paths.scanRuns, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((item) => item?.timestamp?.startsWith(date))
    : [];
  const dayRuns = [...earlierRuns, run];
  const dayErrors = [...new Set(dayRuns.flatMap((item) => item.errors || []))];
  const baseReport = reportText({
    date,
    degraded: dayRuns.some((item) => item.degraded),
    source_health: health,
    kept: merged.tracker.opportunities,
    discarded: merged.discarded,
    reviewed: merged.reviewed,
    errors: dayErrors,
  });
  const runLines = dayRuns.map((item) => {
    const sourcesSummary = Object.entries(item.source_health || {}).map(([name, value]) => `${name}: ${value.status}`).join(', ') || 'no sources';
    return `- **${item.agent} ${item.mode}** at ${String(item.timestamp || '').slice(11, 16) || 'unknown time'} UTC - ${item.skipped ? 'skipped because another scan was running' : item.degraded ? 'degraded' : 'healthy'}; ${item.candidates_found || 0} candidate(s), ${item.keepers_added || 0} added, ${item.keepers_updated || 0} updated; ${sourcesSummary}.`;
  }).join('\n');
  const report = baseReport.replace('## Action today', `## Scan runs\n\n${runLines}\n\n## Action today`);
  if (!error) atomicWrite(paths.tracker, serializeTracker(merged.tracker));
  atomicWrite(path.join(paths.reports, `${date}.md`), report);
  fs.mkdirSync(path.dirname(paths.scanRuns), { recursive: true });
  fs.appendFileSync(paths.scanRuns, `${JSON.stringify(run)}\n`, 'utf8');
  validateWrittenScanArtifacts(root, run);
  return { run, tracker: merged.tracker, report: path.join(paths.reports, `${date}.md`) };
}
