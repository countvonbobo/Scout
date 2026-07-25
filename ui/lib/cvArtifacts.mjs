// Tailored CV artifacts are keyed by the tracked opportunity so two roles at one
// company never share a directory. Legacy company-slug directories stay exactly
// where they are: they are reused in place and flagged, never moved or deleted.
const SLUG = /^[a-z0-9-]+$/;

function slugify(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function artifactSlugFor(opportunity) {
  const id = String(opportunity?.id || '');
  if (SLUG.test(id)) return id;
  return [slugify(opportunity?.company), slugify(opportunity?.role)].filter(Boolean).join('-');
}

export function artifactOwners(existingSlugs, opportunities, slugOfCompany) {
  const owners = new Map();
  for (const slug of existingSlugs || []) {
    const ids = (opportunities || [])
      .filter((o) => artifactSlugFor(o) === slug || slugOfCompany(o.company) === slug)
      .map((o) => o.id);
    owners.set(slug, ids);
  }
  return owners;
}

export function resolveArtifact(existingSlugs, opportunity, slugOfCompany, opportunities = []) {
  const slugs = new Set(existingSlugs || []);
  const preferred = artifactSlugFor(opportunity);
  if (slugs.has(preferred)) return { slug: preferred, legacy: false, ambiguous: false };
  const legacy = slugOfCompany(opportunity?.company);
  if (legacy && slugs.has(legacy)) {
    const sharing = (opportunities || []).filter((o) => slugOfCompany(o.company) === legacy).length;
    return { slug: legacy, legacy: true, ambiguous: sharing > 1 };
  }
  return { slug: preferred, legacy: false, ambiguous: false };
}

// The client decides, via a prompt, whether an existing legacy company folder is
// reused or a fresh per-role folder is started. That answer reaches the write path
// as a requested slug, so it is never trusted verbatim: only a slug this resolver
// would itself produce for this opportunity - the per-role slug, or the legacy
// folder it resolved to - is honoured. Anything else falls back to the resolution.
export function chooseArtifactSlug(existingSlugs, opportunity, slugOfCompany, opportunities = [], requested = '') {
  const resolved = resolveArtifact(existingSlugs, opportunity, slugOfCompany, opportunities);
  const fresh = artifactSlugFor(opportunity);
  const wanted = String(requested || '').trim();
  if (wanted && (wanted === resolved.slug || wanted === fresh)) return wanted;
  return resolved.slug;
}
