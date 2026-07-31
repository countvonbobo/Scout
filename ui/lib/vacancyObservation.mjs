import crypto from 'node:crypto';

const TRACKING_PARAMETERS = /^(?:utm_[^=]+|gclid|fbclid|mc_[^=]+)$/i;
const CREDENTIAL_PARAMETERS = /^(?:access[-_]?token|api[-_]?(?:key|token)|auth(?:orization)?|key|password|secret|session[-_]?id|sig(?:nature)?|token)$/i;
const CREDENTIAL_VALUE = /(?:\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)|(?:\b(?:access[-_ ]?token|api[-_ ]?(?:key|token)|authorization|password|secret|session[-_ ]?id|token)\s*[:=]\s*\S+)|(?:\bbearer\s+[A-Za-z0-9._~+/-]{8,})|(?:\bsk-[A-Za-z0-9_-]{16,})|(?:\bgh[pousr]_[A-Za-z0-9]{20,})|(?:\bxox[baprs]-[A-Za-z0-9-]{10,})|(?:\bAKIA[0-9A-Z]{16}\b)/i;
const MAX_SOURCE_RECORD_ID_LENGTH = 160;

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function metadataText(value) {
  return text(value)?.slice(0, 120) || null;
}

function field(value, provenance) {
  return { value: value ?? null, provenance: value == null ? 'unknown' : provenance };
}

function list(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  return values.map((item) => text(item)?.slice(0, 300) || null).filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  }).slice(0, 32);
}

function listField(value) {
  const values = list(value);
  return field(values.length ? values : null, 'explicit-source');
}

export function canonicaliseUrl(value) {
  const url = text(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(key) || CREDENTIAL_PARAMETERS.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    parsed.searchParams.sort();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

function extraction(description, patterns) {
  const matches = [...new Set(patterns.filter(([, pattern]) => pattern.test(description)).map(([value]) => value))];
  return { value: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
}

function explicitOrExtracted(value, description, patterns, warnings, label) {
  const explicit = text(value);
  if (explicit) return field(explicit.toLowerCase(), 'explicit-source');
  const extracted = extraction(description, patterns);
  if (extracted.ambiguous) warnings.push(`ambiguous ${label} was left unknown`);
  return field(extracted.value, extracted.value ? 'deterministic-extraction' : 'unknown');
}

function compensation(job, warnings) {
  const minimum = text(job.salaryMin) !== null && Number.isFinite(Number(job.salaryMin)) ? Number(job.salaryMin) : null;
  const maximum = text(job.salaryMax) !== null && Number.isFinite(Number(job.salaryMax)) ? Number(job.salaryMax) : null;
  const currency = text(job.salaryCurrency);
  const period = text(job.salaryPeriod);
  const rateType = text(job.salaryRateType || job.compensationRateType || job.rateType);
  const amountType = text(job.compensationAmountType || job.salaryAmountType)?.toLowerCase() || null;
  const certainty = text(job.compensationCertainty || job.salaryCertainty)?.toLowerCase() || null;
  if (minimum !== null || maximum !== null) {
    return field({
      minimum,
      maximum,
      currency,
      period: period?.toLowerCase() || null,
      rateType: rateType?.toLowerCase() || null,
      ...(amountType ? { amountType } : {}),
      ...(certainty ? { certainty } : {}),
    }, 'explicit-source');
  }
  if (text(job.salary)) {
    warnings.push('ambiguous compensation was left unknown');
  } else if (/\b(?:competitive|market[- ]?rate|salary negotiable)\b/i.test(String(job.description || ''))) {
    warnings.push('ambiguous compensation was left unknown');
  }
  return field(null, 'unknown');
}

function sourceRecordId(job, canonicalUrl) {
  const providerId = text(job.sourceRecordId) || text(job.providerId);
  if (!providerId) return canonicalUrl ? `url-${fingerprint(canonicalUrl).slice(0, 16)}` : null;
  let urlShaped = false;
  try {
    const parsed = new URL(providerId);
    urlShaped = ['http:', 'https:'].includes(parsed.protocol);
  } catch {}
  if (urlShaped || providerId.includes('?')
    || providerId.length > MAX_SOURCE_RECORD_ID_LENGTH || CREDENTIAL_VALUE.test(providerId)) {
    return `provider-${fingerprint(providerId).slice(0, 32)}`;
  }
  return providerId;
}

function diagnosticCode(warning) {
  if (/working pattern/i.test(warning)) return 'ambiguous-working-pattern';
  if (/employment type/i.test(warning)) return 'ambiguous-employment-type';
  if (/seniority/i.test(warning)) return 'ambiguous-seniority';
  if (/compensation/i.test(warning)) return 'ambiguous-compensation';
  return 'normalisation-warning';
}

export function normaliseObservation(job, {
  sourceName, collectionSource, fetchedAt, laneId, laneIds, roleFamily,
} = {}) {
  const source = metadataText(sourceName) || metadataText(job?.source);
  if (!job || !source) return null;
  const canonicalUrl = canonicaliseUrl(job.url || job.sourceUrl);
  const title = text(job.title);
  const recordId = sourceRecordId(job, canonicalUrl);
  if (!title || !recordId) return null;

  const description = text(job.description) || '';
  const warnings = [];
  const location = field(text(job.location), 'explicit-source');
  const workingPatterns = [
    ['remote', /\bremote\b/i], ['hybrid', /\bhybrid\b/i], ['on-site', /\b(?:on[ -]?site|onsite)\b/i],
  ];
  const explicitWorkingPattern = text(job.workingPattern || job.workingType);
  const workingPatternAmbiguous = !explicitWorkingPattern && extraction(description, workingPatterns).ambiguous;
  const workingPattern = explicitOrExtracted(explicitWorkingPattern, description, workingPatterns, warnings, 'working pattern');
  if (!workingPattern.value && /\b(?:flexible|flexibility)\b/i.test(description)) warnings.push('ambiguous working pattern was left unknown');
  const employmentType = explicitOrExtracted(job.employmentType, description, [
    ['permanent', /\bpermanent\b/i], ['contract', /\b(?:contract|contractor)\b/i], ['temporary', /\btemporary\b/i], ['internship', /\bintern(?:ship)?\b/i],
  ], warnings, 'employment type');
  const seniority = explicitOrExtracted(job.seniority, `${title} ${description}`, [
    ['junior', /\bjunior\b/i], ['mid', /\b(?:mid[- ]?level|midlevel)\b/i], ['senior', /\bsenior\b/i], ['lead', /\blead\b/i], ['principal', /\bprincipal\b/i],
  ], warnings, 'seniority');
  const fullTime = extraction(description, [['full-time', /\bfull[ -]?time\b/i], ['part-time', /\bpart[ -]?time\b/i]]);
  if (fullTime.ambiguous) warnings.push('ambiguous working pattern was left unknown');
  const observationLaneIds = [...new Set([
    ...(Array.isArray(job.laneIds) ? job.laneIds : []),
    ...(Array.isArray(laneIds) ? laneIds : []),
    job.laneId,
    laneId,
  ].map(metadataText).filter(Boolean))].sort().slice(0, 32);
  const observationLaneId = observationLaneIds[0] || null;
  const observationCollectionSource = metadataText(collectionSource || source);
  const observationRoleFamily = metadataText(
    job.roleFamilyId || job.roleFamily || job.targetRoleFamily || roleFamily,
  );
  const {
    laneId: _laneId,
    laneIds: _laneIds,
    searchQueries: _searchQueries,
    roleFamily: _roleFamily,
    roleFamilyId: _roleFamilyId,
    targetRoleFamily: _targetRoleFamily,
    providerId: _providerId,
    sourceRecordId: _sourceRecordId,
    ...sourceJob
  } = job;
  const fingerprintInput = {
    ...sourceJob,
    sourceRecordId: recordId,
    url: canonicalUrl || text(job.url),
    sourceUrl: canonicalUrl || text(job.sourceUrl),
  };
  const rawFingerprint = fingerprint(stableJson(fingerprintInput));
  const observationId = fingerprint(
    `${source}\n${observationCollectionSource || ''}\n${recordId || canonicalUrl || ''}\n${observationLaneIds.join(',')}\n${observationRoleFamily || ''}\n${rawFingerprint}`,
  );
  const result = {
    observationId,
    source,
    collectionSource: observationCollectionSource,
    sourceRecordId: recordId,
    sourceUrl: canonicalUrl,
    canonicalUrl,
    employer: field(text(job.company || job.employer), 'explicit-source'),
    employerReference: field(text(job.employerReference || job.companyReference || job.employerId), 'explicit-source'),
    title: field(title, 'explicit-source'),
    description,
    responsibilities: listField(job.responsibilities),
    skills: listField(job.skills),
    qualifications: listField(job.qualifications),
    eligibility: listField(job.eligibility),
    industry: field(text(job.industry || job.sector || job.category), 'explicit-source'),
    location,
    workingPattern: workingPattern.value || workingPatternAmbiguous
      ? workingPattern
      : field(fullTime.value, fullTime.value ? 'deterministic-extraction' : 'unknown'),
    employmentType,
    seniority,
    compensation: compensation(job, warnings),
    postedAt: text(job.postedDate || job.postedAt),
    closingAt: text(job.closingDate || job.closingAt || job.expiresAt),
    fetchedAt: text(fetchedAt),
    firstSeenAt: text(job.firstSeenAt) || text(fetchedAt),
    lastSeenAt: text(job.lastSeenAt) || text(fetchedAt),
    laneId: observationLaneId,
    laneIds: observationLaneIds,
    roleFamily: observationRoleFamily,
    warnings,
    rawFingerprint,
    diagnostics: {
      codes: [...new Set(warnings.map(diagnosticCode))].slice(0, 16),
      rawPayloadRetained: false,
      retention: 'fingerprint-only',
    },
  };
  result.fieldProvenance = Object.fromEntries([
    'employer', 'employerReference', 'title', 'responsibilities', 'skills', 'qualifications',
    'eligibility', 'industry', 'location', 'workingPattern', 'employmentType', 'seniority',
    'compensation',
  ].map((name) => [name, result[name].provenance]));
  return deepFreeze(result);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
