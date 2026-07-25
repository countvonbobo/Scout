import { artifactSlugFor } from './cvArtifacts.mjs';

export function slugOf(company) {
  return String(company || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildPrefills(entry, options = {}) {
  // Keyed by the tracked opportunity, not the company, so two roles at one
  // employer never write over each other. The caller resolves and validates the
  // slug (including a deliberately reused legacy company folder); the fallback
  // here is the per-role slug, never the company slug.
  const slug = String(options.artifactSlug || '').trim() || artifactSlugFor(entry);
  const cvPath = `applications/${slug}/cv.typ`;
  const evidencePath = `applications/${slug}/cv-evidence.json`;
  const style = [options.locale, options.tone].filter(Boolean).join(', ') || 'the locale and tone in workspace.json';
  const cvOptions = {
    xyz: options.cvOptions?.xyz !== false,
    humanize: options.cvOptions?.humanize !== false,
  };
  const methods = [
    cvOptions.xyz
      ? 'Use Google XYZ for genuine achievement bullets. First compare the advert with existing evidence; if X, Y or Z is missing, ask one focused question per turn, explain which bullet it would strengthen, and offer Skip and Finish questions. Never invent a metric; a confirmed qualitative outcome is valid.'
      : 'Do not require Google XYZ or run an XYZ evidence interview.',
    cvOptions.humanize
      ? `After the factual first draft, perform a separate natural-voice revision using ${style}; remove generic CV clichés, repetition and keyword stuffing without changing facts.`
      : 'Do not run the optional natural-voice revision.',
  ].join(' ');
  return {
    ask: '',
    fit: `Give me a short, evidence-led fit and gap assessment for ${entry.company} (${entry.role}).`,
    cv: `Create a tailored CV for ${entry.company} (${entry.role}) at ${cvPath}, in Typst, `
      + `${methods} Do not write the CV until I finish or skip the evidence questions. `
      + `Draw only on cv/master-cv.md and the tracker entry for ${entry.id} in data/opportunities.json - invent nothing. `
      + `Record confirmed answers and exact bullet provenance in ${evidencePath}, with options xyz=${cvOptions.xyz} and humanize=${cvOptions.humanize}. `
      + `Use ${style}. Then compile it: typst compile --root . ${cvPath}; Scout runs its quality checks after the turn. `
      + `Draft only, nothing sent.`,
    coverLetter: `Draft a tailored cover letter for ${entry.company} in applications/${slug}/outreach.md - `
      + `draw only on cv/master-cv.md and the tracker entry for ${entry.id} in data/opportunities.json. `
      + `Use ${style}. Draft only, nothing sent.`,
    tweak: `In ${cvPath}, <your change>, then recompile the PDF (typst compile --root . ${cvPath}). `
      + `Update ${evidencePath} so every bullet remains traceable; Scout reruns quality checks after the turn. `
      + `Every claim must trace to cv/master-cv.md or a confirmed answer - invent nothing.`,
    reuseEvidence: `Review the answered questions in ${evidencePath}. Show which confirmed facts could improve cv/master-cv.md, `
      + 'but do not edit it yet. Ask me which facts to promote, then update the master CV only after my explicit confirmation.',
  };
}

export const HANDOFF_SUMMARY_PROMPT =
  'Summarise this conversation for a handoff to another assistant - decisions made, '
  + 'files created or edited (repo-relative paths), and what is still outstanding. '
  + 'Be concise and factual.';

export function handoffOpening(summary) {
  return 'You are taking over an in-progress task in this repo from another assistant. '
    + `Here is their handoff summary:\n\n${summary}\n\n`
    + 'Read the files it mentions before making changes. Continue from where they left off.';
}
