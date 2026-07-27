import crypto from 'node:crypto';

const TRACKING_PARAMETERS = /^(?:utm_[^=]+|gclid|fbclid|mc_[^=]+)$/i;

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

function field(value, provenance) {
  return { value: value ?? null, provenance: value == null ? 'unknown' : provenance };
}

export function canonicaliseUrl(value) {
  const url = text(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(key)) parsed.searchParams.delete(key);
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
  if (minimum !== null || maximum !== null) {
    return field({
      minimum,
      maximum,
      currency,
      period: period?.toLowerCase() || null,
      rateType: rateType?.toLowerCase() || null,
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
  return providerId || (canonicalUrl ? `url-${fingerprint(canonicalUrl).slice(0, 16)}` : null);
}

export function normaliseObservation(job, { sourceName, fetchedAt, laneId } = {}) {
  const source = text(sourceName) || text(job?.source);
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
  const fingerprintInput = { ...job, url: canonicalUrl || text(job.url), sourceUrl: canonicalUrl || text(job.sourceUrl) };
  const rawFingerprint = fingerprint(stableJson(fingerprintInput));
  const observationId = fingerprint(`${source}\n${recordId || canonicalUrl || ''}\n${rawFingerprint}`);
  const result = {
    observationId,
    source,
    sourceRecordId: recordId,
    sourceUrl: text(job.url || job.sourceUrl),
    canonicalUrl,
    employer: field(text(job.company || job.employer), 'explicit-source'),
    title: field(title, 'explicit-source'),
    description,
    location,
    workingPattern: workingPattern.value || workingPatternAmbiguous
      ? workingPattern
      : field(fullTime.value, fullTime.value ? 'deterministic-extraction' : 'unknown'),
    employmentType,
    seniority,
    compensation: compensation(job, warnings),
    postedAt: text(job.postedDate || job.postedAt),
    fetchedAt: text(fetchedAt),
    laneId: text(laneId),
    warnings,
    rawFingerprint,
  };
  result.fieldProvenance = Object.fromEntries([
    'employer', 'title', 'location', 'workingPattern', 'employmentType', 'seniority', 'compensation',
  ].map((name) => [name, result[name].provenance]));
  return deepFreeze(result);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
