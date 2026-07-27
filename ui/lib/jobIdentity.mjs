const COMPANY_SUFFIXES = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'limited', 'llc', 'ltd', 'plc']);
const EVIDENCE_NOISE = new Set([
  'about', 'after', 'also', 'and', 'are', 'but', 'for', 'from', 'have', 'into', 'our', 'that', 'the',
  'their', 'this', 'with', 'will', 'you', 'your', 'role', 'team', 'work', 'working',
]);
const IDENTITY_CACHE = new WeakMap();

function fieldValue(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

export function normaliseIdentityText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(value, ignored = new Set()) {
  return normaliseIdentityText(value).split(' ').filter((token) => token.length > 1 && !ignored.has(token));
}

function companyKey(value) {
  const values = tokens(value);
  while (values.length > 1 && COMPANY_SUFFIXES.has(values.at(-1))) values.pop();
  return values.join(' ');
}

function titleKey(value) { return tokens(value).join(' '); }
function locationTokens(value) { return tokens(value); }

function evidenceTokens(value) {
  return [...new Set(tokens(value, EVIDENCE_NOISE).filter((token) => token.length > 2))].sort().slice(0, 80);
}

function similarity(left, right) {
  const a = new Set(left); const b = new Set(right);
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((value) => b.has(value)).length;
  return shared / (a.size + b.size - shared);
}

export function canonicalJobUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|ref$|referrer$|source$|tracking|trk$|gh_src$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch { return ''; }
}

export function sourceReferencesOf(job) {
  const provided = Array.isArray(job?.sourceReferences) ? job.sourceReferences : [];
  const urls = [...(Array.isArray(job?.sources) ? job.sources : []), job?.canonicalUrl, job?.url, job?.sourceUrl].filter(Boolean);
  const references = [
    ...provided,
    { source: job?.source, providerId: job?.providerId || job?.sourceRecordId, url: job?.canonicalUrl || job?.url || job?.sourceUrl },
    ...urls.map((url) => ({ source: '', providerId: '', url })),
  ].map((reference) => ({
    source: normaliseIdentityText(reference?.source),
    providerId: String(reference?.providerId || '').trim(),
    url: canonicalJobUrl(reference?.url),
  })).filter((reference) => reference.source || reference.providerId || reference.url);
  return [...new Map(references.map((reference) => [
    `${reference.source}|${reference.providerId}|${reference.url}`, reference,
  ])).values()];
}

export function jobIdentity(job) {
  if (job && typeof job === 'object') {
    const cached = IDENTITY_CACHE.get(job);
    if (cached) return cached;
  }
  const role = fieldValue(job?.role) || fieldValue(job?.title);
  const description = job?.description || job?.jobIdentity?.advertFingerprint
    || (job?.mandatoryRequirements || []).map((item) => `${item.requirement || ''} ${item.advertEvidence || ''}`).join(' ');
  const location = fieldValue(job?.location) || job?.jobIdentity?.location || '';
  const seniority = fieldValue(job?.seniority) || job?.jobIdentity?.seniority || '';
  const identity = {
    company: companyKey(fieldValue(job?.company) || fieldValue(job?.employer) || job?.jobIdentity?.company),
    title: titleKey(role || job?.jobIdentity?.title),
    titleTokens: tokens(role || job?.jobIdentity?.title),
    location: normaliseIdentityText(location),
    locationTokens: locationTokens(location),
    seniority: normaliseIdentityText(seniority),
    advertFingerprint: evidenceTokens(description).join(' '),
    evidenceTokens: evidenceTokens(description),
    references: sourceReferencesOf(job),
  };
  if (job && typeof job === 'object') IDENTITY_CACHE.set(job, identity);
  return identity;
}

export function invalidateJobIdentity(job) {
  if (job && typeof job === 'object') IDENTITY_CACHE.delete(job);
}

function locationsCompatible(a, b) {
  if (!a.location || !b.location) return true;
  if (a.location === b.location) return true;
  const remoteA = a.locationTokens.includes('remote'); const remoteB = b.locationTokens.includes('remote');
  if (remoteA || remoteB) return remoteA && remoteB;
  const [cityOnly, qualifiedLocation] = a.locationTokens.length === 1
    ? [a.locationTokens, b.locationTokens]
    : b.locationTokens.length === 1
      ? [b.locationTokens, a.locationTokens]
      : [[], []];
  if (cityOnly.length && qualifiedLocation[0] === cityOnly[0]) return true;
  return similarity(a.locationTokens, b.locationTokens) >= 0.5;
}

export function sameUnderlyingJob(left, right) {
  const a = jobIdentity(left); const b = jobIdentity(right);
  if (!locationsCompatible(a, b)) return false;
  if (a.seniority && b.seniority && a.seniority !== b.seniority) return false;
  for (const first of a.references) {
    for (const second of b.references) {
      if (first.source && first.source === second.source && first.providerId && second.providerId && first.providerId !== second.providerId) return false;
    }
  }
  const urlsA = new Set(a.references.map((item) => item.url).filter(Boolean));
  if (b.references.some((item) => item.url && urlsA.has(item.url))) return true;
  for (const first of a.references) {
    for (const second of b.references) {
      if (first.source && first.source === second.source && first.providerId && second.providerId) {
        if (first.providerId === second.providerId) return true;
      }
    }
  }
  if (!a.company || a.company !== b.company || !a.title || !b.title) return false;
  if (a.title !== b.title && similarity(a.titleTokens, b.titleTokens) < 0.8) return false;
  if (a.evidenceTokens.length >= 8 && b.evidenceTokens.length >= 8) {
    return similarity(a.evidenceTokens, b.evidenceTokens) >= 0.35;
  }
  return a.title === b.title;
}

export function advertMateriallyChanged(previous, current) {
  const a = jobIdentity(previous); const b = jobIdentity(current);
  if (a.evidenceTokens.length < 8 || b.evidenceTokens.length < 8) return false;
  return similarity(a.evidenceTokens, b.evidenceTokens) < 0.55;
}

export function mergeSourceReferences(...jobs) {
  return sourceReferencesOf({ sourceReferences: jobs.flatMap((job) => sourceReferencesOf(job)) });
}
