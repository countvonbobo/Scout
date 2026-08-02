// Pure helpers for the /api/source route: HTML -> readable text, key-fact
// extraction (JSON-LD JobPosting first, heuristics second), and a TTL cache.

export const THIN_TEXT_CHARS = 200;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  pound: '£', euro: '€', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  times: '×', middot: '·', bull: '•', trade: '™', copy: '©', reg: '®',
  deg: '°', laquo: '«', raquo: '»', sect: '§',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const DROP_TAGS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'header', 'footer'];
const BLOCK_TAGS = 'p|div|section|article|main|aside|li|ul|ol|h[1-6]|tr|table|br|hr|blockquote|dt|dd|figure';

export function htmlToText(html) {
  let s = String(html ?? '');
  for (const tag of DROP_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})(?:\\s[^>]*)?\\/?>`, 'gi'), '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\r]+/g, ' ');
  s = s.split('\n').map((line) => line.trim()).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch { /* malformed JSON-LD: skip */ }
  }
  return blocks;
}

function findJobPosting(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findJobPosting(item); if (hit) return hit; }
    return null;
  }
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.includes('JobPosting')) return node;
  return findJobPosting(node['@graph']);
}

function salaryText(baseSalary) {
  if (baseSalary == null) return null;
  if (typeof baseSalary !== 'object') return String(baseSalary);
  const currency = baseSalary.currency ? `${baseSalary.currency} ` : '';
  const v = baseSalary.value;
  if (v == null) return null;
  if (typeof v !== 'object') return `${currency}${v}`.trim();
  const range = v.minValue != null && v.maxValue != null ? `${v.minValue}–${v.maxValue}`
    : v.value != null ? String(v.value) : null;
  if (range === null) return null;
  const unit = v.unitText ? ` per ${String(v.unitText).toLowerCase()}` : '';
  return `${currency}${range}${unit}`.trim();
}

function locationText(jobLocation) {
  const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (!first) return null;
  if (typeof first === 'string') return first;
  const a = first.address;
  if (!a) return null;
  if (typeof a === 'string') return a;
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function extractJobFacts(html) {
  const facts = {};
  for (const block of jsonLdBlocks(html)) {
    const job = findJobPosting(block);
    if (!job) continue;
    if (job.title) facts.title = String(job.title);
    const salary = salaryText(job.baseSalary);
    if (salary) facts.salary = salary;
    const location = locationText(job.jobLocation);
    if (location) facts.location = location;
    if (job.employmentType) {
      facts.employmentType = Array.isArray(job.employmentType)
        ? job.employmentType.join(', ') : String(job.employmentType);
    }
    if (job.datePosted) facts.datePosted = String(job.datePosted).slice(0, 10);
    if (job.validThrough) facts.validThrough = String(job.validThrough).slice(0, 10);
    break;
  }
  const text = htmlToText(html);
  if (!facts.salary) {
    // Salary-shaped only: comma thousands (£70,000), a k suffix (£70k), or a
    // plain 4-6 digit figure — never bare 2-3 digits like the "$11" in
    // "raised $11 million".
    const amount = '(?:\\d{2,3}(?:,\\d{3})+|\\d{2,3}k|\\d{4,6})';
    const m = text.match(new RegExp(`[£€$]\\s?${amount}(?:\\s?(?:-|–|—|to)\\s?[£€$]?\\s?${amount})?`, 'i'));
    if (m) facts.salary = m[0].trim();
  }
  if (!facts.validThrough) {
    const m = text.match(/(?:closing date|closes|deadline|apply by)[:\s]+([^\n]{4,40})/i);
    if (m) facts.validThrough = m[1].trim();
  }
  const mode = text.match(/\b(hybrid|remote|on-?site)\b/i);
  if (mode) facts.workMode = mode[1].toLowerCase();
  if (!facts.title) {
    const t = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) {
      const title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim();
      if (title) facts.title = title;
    }
  }
  return facts;
}

export function buildSourcePayload(html, url, fetchedAt) {
  const text = htmlToText(html);
  let publicUrl = null;
  try {
    const parsed = new URL(String(url || ''));
    if (['http:', 'https:'].includes(parsed.protocol)) {
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      publicUrl = parsed.toString();
    }
  } catch {}
  return {
    ok: true,
    url: publicUrl,
    fetchedAt,
    facts: extractJobFacts(html),
    text,
    thin: text.length < THIN_TEXT_CHARS,
  };
}

export function sourceUrlOf(entry) {
  const raw = entry && Array.isArray(entry.sources) ? entry.sources[0] : null;
  if (!raw) return null;
  try {
    const u = new URL(String(raw));
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}

export class SourceCache {
  constructor(ttlMs = 60 * 60 * 1000, now = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) { this.map.delete(key); return null; }
    return hit.value;
  }
  set(key, value) { this.map.set(key, { at: this.now(), value }); }
}
