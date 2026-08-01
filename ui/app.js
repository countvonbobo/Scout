import { createChatDrawerState, reduceChatDrawer } from './lib/chatDrawerState.mjs?v=__SCOUT_UI_BUILD__';
import { openCodexTask as codexTaskLaunchView } from './lib/codexDeepLink.mjs?v=__SCOUT_UI_BUILD__';

// Keep browser orchestration here while pure state machines live in /lib, where
// deterministic unit tests exercise them without a DOM. Scout character data
// is likewise read from its canonical module rather than copied here.
const SCOUT_UI_BUILD = typeof document !== 'undefined'
  ? document.querySelector?.('meta[name="scout-ui-build"]')?.content || null
  : null;
// Character frame count, frame rate, looping, reduced-motion frame and anchor
// belong to ui/lib/scoutCharacter.mjs alone. index.html loads that module and it
// publishes window.ScoutCharacter; app.js only forwards to it, so there is no
// second place a state's timing or alignment can disagree from.
const scoutCharacter = () => (typeof window !== 'undefined' ? window.ScoutCharacter : null);
function activityState(activity) {
  return scoutCharacter()?.activityState(activity) || 'thinking';
}
// The module is deferred, so a render can land before it evaluates, and it may
// never evaluate at all if the request fails. Emitting nothing would leave
// arrival, the chat companion and every assistant message permanently without
// Scout or its accessible name, because later hydration can only adopt markup
// that already exists. So emit a bounded, named placeholder carrying the state
// for the module to hydrate — no timing, alignment or label table, just the
// character's own name until the canonical one arrives.
function scoutMarkup(state = 'idle', className = '') {
  const character = scoutCharacter();
  if (character) return character.scoutMarkup(state, className);
  const name = String(state).replace(/[^a-z]/gi, '') || 'idle';
  return `<span class="scout-character ${className}" data-scout-state="${name}" role="img" aria-label="Scout"><span class="scout-sprite" aria-hidden="true"></span></span>`;
}
function applyScoutState(element, state, options = {}) {
  return scoutCharacter()?.applyScoutState(element, state, options) || null;
}
function strongUnseenMatches(entries, threshold, acknowledged = []) {
  const seen = new Set(acknowledged || []);
  return (entries || []).filter((entry) => entry.status === 'new' && Number.isFinite(entry.score) && entry.score >= threshold && !seen.has(entry.id));
}
function discoveryStorageKey(identity = 'default') {
  let hash = 2166136261;
  for (const char of String(identity)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `scout.discoveries.${(hash >>> 0).toString(36)}.v1`;
}
function mergeAcknowledged(current, entries) {
  return [...new Set([...(current || []), ...(entries || []).map((entry) => entry.id).filter(Boolean)])];
}
const CATEGORY_PALETTE = [
  { bg: '#4a73c3', fg: '#ffffff' }, { bg: '#b05f3b', fg: '#ffffff' },
  { bg: '#3bb59a', fg: '#04231c' }, { bg: '#8266ba', fg: '#ffffff' },
  { bg: '#ca4658', fg: '#ffffff' }, { bg: '#3e825c', fg: '#ffffff' },
  { bg: '#c9a227', fg: '#241f04' }, { bg: '#5a7896', fg: '#ffffff' },
];
function categoryColor(categoryId, categoryIds) {
  const index = Array.isArray(categoryIds) ? categoryIds.indexOf(categoryId) : -1;
  const position = index >= 0 ? index : 0;
  return CATEGORY_PALETTE[position % CATEGORY_PALETTE.length];
}
// Tailored CV artifacts are keyed by the tracked opportunity so two roles at one
// company never share a directory. Legacy company-slug directories stay exactly
// where they are: they are reused in place and flagged, never moved or deleted.
// Inlined verbatim (behaviourally) from ui/lib/cvArtifacts.mjs — this is a classic
// script and cannot use `import`.
const CV_SLUG = /^[a-z0-9-]+$/;
function cvSlugify(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function artifactSlugFor(opportunity) {
  const id = String(opportunity?.id || '');
  if (CV_SLUG.test(id)) return id;
  return [cvSlugify(opportunity?.company), cvSlugify(opportunity?.role)].filter(Boolean).join('-');
}
function resolveArtifact(existingSlugs, opportunity, slugOfCompany, opportunities = []) {
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
function chooseArtifactSlug(existingSlugs, opportunity, slugOfCompany, opportunities = [], requested = '') {
  const resolved = resolveArtifact(existingSlugs, opportunity, slugOfCompany, opportunities);
  const fresh = artifactSlugFor(opportunity);
  const wanted = String(requested || '').trim();
  if (wanted && (wanted === resolved.slug || wanted === fresh)) return wanted;
  return resolved.slug;
}
const ScoutModal = (() => {
  const stack = [];
  const registrations = new WeakMap();
  const originalInert = new Map();
  const focusableSelector = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
    'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const isVisible = (element) => Boolean(element && !element.classList.contains('hidden'));
  const focusableElements = (element) => [...element.querySelectorAll(focusableSelector)]
    .filter((candidate) => candidate.getClientRects().length && candidate.getAttribute('aria-hidden') !== 'true');
  const top = () => stack[stack.length - 1] || null;

  function syncBackground() {
    const active = top()?.element || null;
    if (!active) {
      originalInert.forEach((value, element) => { element.inert = value; });
      originalInert.clear();
      return;
    }
    [...document.body.children].forEach((element) => {
      if (!originalInert.has(element)) originalInert.set(element, Boolean(element.inert));
      element.inert = element !== active && !element.contains(active);
    });
  }

  function focusInitial(entry) {
    requestAnimationFrame(() => {
      if (top() !== entry || !isVisible(entry.element)) return;
      const requested = typeof entry.options.initialFocus === 'function'
        ? entry.options.initialFocus(entry.element)
        : entry.options.initialFocus;
      const target = typeof requested === 'string'
        ? entry.element.querySelector(requested)
        : requested || focusableElements(entry.element)[0];
      const focusTarget = target || entry.element;
      if (!target && !focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    });
  }

  function activate(element, options = {}) {
    const existing = stack.findIndex((entry) => entry.element === element);
    if (existing >= 0) {
      stack[existing].options = options;
      return;
    }
    const entry = { element, options, returnFocus: document.activeElement };
    stack.push(entry);
    syncBackground();
    focusInitial(entry);
  }

  function deactivate(element) {
    const index = stack.findIndex((entry) => entry.element === element);
    if (index < 0) return;
    const [entry] = stack.splice(index, 1);
    syncBackground();
    if (index === stack.length && entry.returnFocus?.isConnected) {
      entry.returnFocus.focus({ preventScroll: true });
    }
  }

  function register(element, options = {}) {
    if (!element || registrations.has(element)) return;
    const sync = () => {
      if (isVisible(element)) activate(element, options);
      else deactivate(element);
    };
    registrations.set(element, new MutationObserver(sync));
    registrations.get(element).observe(element, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  function focus(element, requested) {
    requestAnimationFrame(() => {
      if (top()?.element !== element || !isVisible(element)) return;
      const target = typeof requested === 'string' ? element.querySelector(requested) : requested;
      target?.focus({ preventScroll: true });
    });
  }

  document.addEventListener?.('keydown', (event) => {
    const entry = top();
    if (!entry) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      entry.options.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(entry.element);
    if (!focusable.length) {
      event.preventDefault();
      entry.element.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const activeIndex = focusable.indexOf(active);
    if (event.shiftKey && activeIndex <= 0) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (activeIndex < 0 || active === last)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }, true);

  return { focus, register };
})();
window.ScoutModal = ScoutModal;

const Scout = {
  state: {
    data: null,
    sort: { key: 'score', dir: -1 },
    filter: '',
    tab: 'jobs',
    commute: { mode: 'either', maxMinutes: '180', includeUnknown: true },
  },
  cvState: { path: null, slug: null, opportunityId: null, content: null, dirty: false },
  cvOptionsOpportunityId: null,
  cvPreviewZoom: 'page-width',
  cvRenderTimer: null,
  chat: null,
  chatDrawerState: null,
  chatOpenSeq: 0,
  engineOptions: null,
  enginePicks: {},
  workspaceConfig: null,
  discoveries: [],
  discoveryTimer: null,
  scanRunning: false,
  scanOperationTimer: null,
  latestScan: null,
  feedbackLearning: null,
  lastSyncPullAt: null,
  companyHistory: null,
  uiBuildId: SCOUT_UI_BUILD,
  serviceWorkerRegistration: null,
  uiUpdateAvailable: false,

  async api(pathname, opts) {
    try {
      const r = await fetch(pathname, opts);
      this.setHostAvailable(true);
      const ct = r.headers.get('content-type') || '';
      return ct.includes('json') ? r.json() : r.text();
    } catch (error) {
      this.setHostAvailable(false);
      throw error;
    }
  },

  setHostAvailable(available) {
    document.getElementById('host-unavailable')?.classList.toggle('hidden', available);
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c]));
  },
  jsArg(s) { return this.esc(JSON.stringify(String(s ?? '')).replace(/</g, '\\u003c')); },
  cardById(id) {
    const visible = document.querySelector('main > section:not(.hidden)');
    return visible
      ? [...visible.querySelectorAll('.card[data-id]')].find((card) => card.dataset.id === String(id))
      : null;
  },
  stages(e) { return (e.application && Array.isArray(e.application.stages)) ? e.application.stages : []; },
  currentStage(e) {
    const next = this.stages(e).find((s) => !s.completed);
    return next ? next.name : '';
  },
  categories() {
    const configured = this.state.data?.categories;
    return Array.isArray(configured) && configured.length
      ? configured
      : [{ id: 'startup', label: 'Priority' }, { id: 'established', label: 'Explore' }];
  },
  categoryIds() { return this.categories().map((category) => category.id); },
  categoryLabel(id) { return this.categories().find((category) => category.id === id)?.label || id; },
  triagePolicy() { return { actionScore: 70, checkScore: 55, ...(this.workspaceConfig?.triage || {}) }; },
  categoryOf(e) {
    const raw = String(e.category || e.jobCategory || '').toLowerCase();
    const ids = this.categoryIds();
    if (ids.includes(raw)) return raw;
    if (['scaleup', 'hidden', 'speculative'].includes(raw)) return ids.includes('startup') ? 'startup' : ids[0];
    if (['corporate', 'mainstream', 'bigtech', 'big-tech', 'prime', 'standard'].includes(raw)) {
      return ids.includes('established') ? 'established' : (ids[1] || ids[0]);
    }
    return ids[0] || 'startup';
  },
  minuteValue(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  },
  commuteMinutes(e, mode) {
    const c = e.commute || {};
    if (mode === 'car') return this.minuteValue(c.carMinutes);
    return this.minuteValue(c.publicTransportMinutes ?? c.trainMinutes);
  },
  commuteLine(e) {
    const car = this.commuteMinutes(e, 'car');
    const pub = this.commuteMinutes(e, 'public');
    const bits = [];
    if (car !== null) bits.push(`car ${car}m`);
    if (pub !== null) bits.push(`public ${pub}m`);
    if (!bits.length) return '';
    const origin = (e.commute && e.commute.originPostcode) || this.workspaceConfig?.commute?.origin;
    return origin ? `${bits.join(' / ')} from ${origin}` : bits.join(' / ');
  },
  matchesCommute(e) {
    const { mode, maxMinutes, includeUnknown } = this.state.commute;
    if (mode === 'any' || maxMinutes === '' || maxMinutes === null || maxMinutes === undefined) return true;
    const max = Number(maxMinutes);
    const car = this.commuteMinutes(e, 'car');
    const pub = this.commuteMinutes(e, 'public');
    if (mode === 'car') return car === null ? includeUnknown : car <= max;
    if (mode === 'public') return pub === null ? includeUnknown : pub <= max;
    const known = [car, pub].filter((minutes) => minutes !== null);
    return known.length ? known.some((minutes) => minutes <= max) : includeUnknown;
  },
  filteredEntries(category = 'all') {
    const rows = [...(this.state.data?.opportunities || [])];
    return rows.filter((e) => (category === 'all' || this.categoryOf(e) === category) && this.matchesCommute(e));
  },
  isSpeculative(e) {
    return (e?.tags || []).some((tag) => String(tag).trim().toLowerCase() === 'speculative outreach');
  },
  fitClass(score) {
    if (typeof score !== 'number') return 'fit-weak';
    const policy = this.triagePolicy();
    if (score >= policy.actionScore) return 'fit-strong';
    if (score >= policy.checkScore) return 'fit-medium';
    return 'fit-weak';
  },
  safeHref(s) {
    try {
      const u = new URL(String(s ?? ''));
      return (u.protocol === 'http:' || u.protocol === 'https:') ? this.esc(u.href) : '';
    } catch {
      return '';
    }
  },
  primarySource(e) {
    return (e.sources && e.sources[0]) ? this.safeHref(e.sources[0]) : '';
  },

  async loadOpportunities({ durableRuns: suppliedRuns, durableQueue: suppliedQueue } = {}) {
    const [data, cvFiles, latest, durableRuns, durableQueue, feedbackLearning] = await Promise.all([
      this.api('/api/opportunities'),
      this.api('/api/cv'),
      this.api('/api/scans/latest').catch(() => ({ scan: null })),
      suppliedRuns === undefined
        ? this.api('/api/scan/runs').catch(() => ({ state: 'waiting', runs: [] }))
        : Promise.resolve(suppliedRuns),
      suppliedQueue === undefined
        ? this.api('/api/scan/queue').catch(() => ({ state: 'waiting', requests: [] }))
        : Promise.resolve(suppliedQueue),
      this.api('/api/feedback-learning').catch(() => null),
    ]);
    this.state.data = data;
    this.state.cvFiles = cvFiles;
    this.latestScan = latest?.scan || null;
    this.scanRuns = Array.isArray(durableRuns?.runs) ? durableRuns.runs : [];
    this.scanRunState = durableRuns?.state || 'waiting';
    this.scanQueue = durableQueue && Array.isArray(durableQueue.requests)
      ? durableQueue
      : { state: 'waiting', requests: [] };
    this.feedbackLearning = feedbackLearning;
    this.applyWorkspaceConfig(this.state.data.workspaceConfig, { render: false });
    const h = this.state.data.scanHealth;
    const activeRun = this.scanRuns.find((run) => !['complete', 'partial', 'abandoned', 'failed'].includes(run.state));
    const queuedCount = this.scanQueue.requests.filter((request) => request.status === 'queued').length;
    const status = document.getElementById('scan-status');
    if (status && !this.scanRunning) {
      status.textContent = activeRun
        ? `${activeRun.label || 'Scan in progress'}${activeRun.assessment?.totalBatches ? ` · batch ${activeRun.assessment.currentBatch} of ${activeRun.assessment.totalBatchesExact ? '' : 'at least '}${activeRun.assessment.totalBatches}` : ''}`
        : queuedCount
        ? `${queuedCount} queued ${queuedCount === 1 ? 'request' : 'requests'}`
        : h?.lastRunAt
        ? `Last scan: ${Number(h.funnel?.assessed ?? h.candidatesFound ?? 0)} assessed · ${Number(h.keepersAdded || 0)} kept`
        : 'Waiting to scan';
      status.dataset.action = h?.lastRunAt ? 'open-scan-result' : '';
      status.tabIndex = h?.lastRunAt ? 0 : -1;
      status.setAttribute('role', h?.lastRunAt ? 'button' : 'status');
    }
    this.renderJobs();
    this.renderSpeculative();
    this.renderShortlist();
    this.renderPipeline();
    this.renderAll();
    this.queueStrongMatches();
  },

  async scanNow() {
    if (this.scanRunning || this.chat?.streaming) return;
    const button = document.getElementById('scan-now');
    this.scanRunning = true;
    if (button) { button.disabled = true; button.textContent = 'Scanning…'; }
    document.getElementById('scan-status').textContent = 'Scout is searching now…';
    try {
      const response = await fetch('/api/scan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: this.workspaceConfig?.ai?.provider }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Scan failed (${response.status})`);
      this.showOperation(result.operation);
      this.watchScanOperation(result.operation.id);
    } catch (error) {
      document.getElementById('scan-status').textContent = error.message;
      this.scanRunning = false;
      if (button) { button.disabled = false; button.textContent = 'Scan now'; }
    }
  },

  showOperation(operation) {
    if (!operation || operation.type !== 'scan') return;
    const status = document.getElementById('scan-status');
    if (!status) return;
    const started = Date.parse(operation.startedAt || '');
    const finished = Date.parse(operation.finishedAt || '');
    const end = Number.isFinite(finished) ? finished : Date.now();
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((end - started) / 1000)) : 0;
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const step = operation.progress ? `step ${operation.progress.current}/${operation.progress.total}` : '';
    const estimate = operation.estimate;
    let remaining = '';
    if (estimate && !['failed', 'succeeded'].includes(operation.status)) {
      const low = Number(estimate.totalSecondsLow || 0);
      const high = Number(estimate.totalSecondsHigh || 0);
      if (seconds > high) remaining = `taking longer than the recent ${Math.max(1, Math.ceil(low / 60))}–${Math.max(1, Math.ceil(high / 60))} min range; still working`;
      else {
        const lowMinutes = Math.max(0, Math.floor((low - seconds) / 60));
        const highMinutes = Math.max(1, Math.ceil((high - seconds) / 60));
        remaining = lowMinutes < 1 ? `about ${highMinutes} min or less remaining` : `about ${lowMinutes}–${highMinutes} min remaining`;
      }
    }
    status.textContent = operation.status === 'failed'
      ? `Scan needs attention: ${operation.error || 'unknown error'}`
      : operation.status === 'succeeded' ? 'Scan completed — refreshing results…'
        : `${operation.phase || 'Scout is searching'} · ${step} · ${elapsed}${remaining ? ` · ${remaining}` : ''}`;
  },

  discardBreakdown(scan = this.latestScan || this.state.data?.scanHealth) {
    const labels = { hard_exclusion: 'hard exclusions', mandatory_unmet: 'mandatory gates', below_threshold: 'below threshold', provider_discarded: 'assessment discards' };
    return Object.entries(scan?.discarded || {}).filter(([, count]) => Number(count) > 0)
      .map(([key, count]) => `${count} ${labels[key] || key.replaceAll('_', ' ')}`).join(', ');
  },

  latestScanCard() {
    const audit = this.scanRunAuditCard();
    const scan = this.latestScan;
    if (!scan?.runAt) return audit;
    const broadened = scan.automaticBroadened ? ' after an automatic broader discovery pass' : '';
    return `${audit}<div class="card scan-result-card">
      <div class="top"><b>Latest scan result</b><span class="chip">${this.esc(scan.degraded ? 'degraded' : 'complete')}</span></div>
      <p><strong>${this.esc(scan.funnel?.assessed ?? scan.candidatesFound)} assessed, ${this.esc(scan.keepersAdded)} kept</strong>${this.discardBreakdown(scan) ? ` — ${this.esc(this.discardBreakdown(scan))}` : ''}${this.esc(broadened)}.</p>
      <p class="meta">Zero keepers can be a valid result: Scout keeps approved gates in force even when it broadens discovery.</p>
      <div class="controls"><button class="act" data-action="open-scan-result">Review this scan</button>${scan.reportDate ? `<button class="act" data-action="open-scan-report" data-date="${this.esc(scan.reportDate)}">Open dated report</button>` : ''}</div>
    </div>`;
  },

  scanRunAuditCard() {
    const run = Array.isArray(this.scanRuns) ? this.scanRuns[0] : null;
    const queued = (this.scanQueue?.requests || []).filter((request) => request.status === 'queued');
    if (!run && !queued.length) {
      if (this.scanRunState !== 'waiting' && this.scanQueue?.state !== 'waiting') return '';
      return `<div class="card scan-run-audit">
        <div class="top"><b>Durable scan state</b><span class="chip">waiting</span></div>
        <p><strong>Waiting to scan</strong></p>
      </div>`;
    }
    const batch = run?.assessment?.totalBatches
      ? ` · batch ${this.esc(run.assessment.currentBatch)} of ${run.assessment.totalBatchesExact ? '' : 'at least '}${this.esc(run.assessment.totalBatches)}`
      : '';
    const recoveries = Number(run?.recoveryCount || 0);
    const recoveryText = `${recoveries} ${recoveries === 1 ? 'recovery' : 'recoveries'}`;
    const queueText = `${queued.length} queued ${queued.length === 1 ? 'request' : 'requests'}`;
    const terminal = run?.terminalReason ? ` · ${this.esc(run.terminalReason)}` : '';
    return `<div class="card scan-run-audit">
      <div class="top"><b>Durable scan state</b><span class="chip">${this.esc(run?.state || 'queued')}</span></div>
      ${run ? `<p><strong>${this.esc(run.label || run.state)}</strong>${batch}${terminal}</p>
        <div class="meta">run ${this.esc(run.id)} · ${this.esc(run.owner || 'inactive worker')} · ${this.esc(recoveryText)}</div>` : ''}
      <div class="meta">${this.esc(queueText)}</div>
    </div>`;
  },

  scanHealthCard() {
    const health = this.state.data?.scanHealth;
    const healthText = health
      ? `${health.healthy ? 'healthy' : (health.stale ? 'stale' : 'degraded')}${health.reason ? ' - ' + health.reason : ''}`
      : 'unknown';
    const sourceHealth = (health?.sourceHealth || []).length
      ? `<div class="source-health">${health.sourceHealth.map((source) => `<span class="chip source-${this.esc(source.status)}" title="${this.esc(source.reason || '')}">${this.esc(source.name)}: ${this.esc(source.status)}${source.count === null ? '' : ` (${this.esc(source.count)})`}</span>`).join('')}</div>`
      : '<div class="meta">No per-source health was recorded for this run.</div>';
    const reportDate = String(health?.lastRunAt || '').slice(0, 10);
    const funnel = health?.funnel;
    const funnelRows = funnel ? [
      ['Source records returned', funnel.sourceRecords], ['Source or portal errors', funnel.sourceErrors],
      ['Records not normalised', funnel.failedSourceRecords], ['Unique vacancies after deduplication', funnel.uniqueVacancies],
      ['Excluded by confirmed rules', funnel.deterministicallyExcluded], ['Eligible and ranked', funnel.ranked],
      ['Selected for detailed assessment', funnel.selected], ['Successfully assessed', funnel.assessed], ['Assessment failed', funnel.assessmentFailed],
    ].filter(([, value]) => Number.isFinite(Number(value))).map(([label, value]) => `<li>${this.esc(label)}: <b>${this.esc(value)}</b></li>`).join('') : '';
    return `${this.scanRunAuditCard()}<div class="card">
      <div class="top"><b>Scan health</b><span class="chip">${this.esc(healthText)}</span></div>
      <p><strong>${this.esc(Number(health?.funnel?.assessed ?? health?.candidatesFound ?? 0))} assessed, ${this.esc(Number(health?.keepersAdded || 0))} kept</strong>${this.discardBreakdown(health) ? ` — ${this.esc(this.discardBreakdown(health))}` : ''}. Zero keepers can be a valid result when strict gates exclude every candidate.</p>
      <div class="meta">last run: ${this.esc(health?.lastRunAt || 'never')}</div>
      ${funnelRows ? `<ul class="meta">${funnelRows}</ul>` : ''}
      ${sourceHealth}
      <p><button class="act" data-action="open-scan-result">Review this scan</button> ${/^\d{4}-\d{2}-\d{2}$/.test(reportDate) ? `<button class="act" data-action="open-scan-report" data-date="${this.esc(reportDate)}">Review dated report</button>` : ''}</p>
    </div>`;
  },

  async watchScanOperation(id) {
    if (!id) return;
    if (this.scanOperationTimer) clearTimeout(this.scanOperationTimer);
    this.scanRunning = true;
    const button = document.getElementById('scan-now');
    if (button) { button.disabled = true; button.textContent = 'Scanning…'; }
    const poll = async () => {
      try {
        const response = await fetch(`/api/operations/${encodeURIComponent(id)}`);
        if (response.status === 404) {
          this.scanOperationTimer = null;
          await this.reattachScanOperation({ reconcileMissing: true });
          return;
        }
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Scan status unavailable');
        this.showOperation(body.operation);
        if (['queued', 'running'].includes(body.operation.status)) {
          this.scanOperationTimer = setTimeout(poll, 1000);
          return;
        }
        this.scanOperationTimer = null;
        this.scanRunning = false;
        if (button) { button.disabled = false; button.textContent = 'Scan now'; }
        if (body.operation.status === 'succeeded') await this.loadOpportunities();
      } catch {
        // A transient transport or decoding failure is not evidence that the
        // durable operation stopped. Keep the UI fenced and retry discovery;
        // only a terminal operation response may re-enable submission.
        this.scanOperationTimer = setTimeout(poll, 1000);
      }
    };
    this.scanOperationTimer = setTimeout(poll, 250);
  },

  async reattachScanOperation({ reconcileMissing = false } = {}) {
    const button = document.getElementById('scan-now');
    try {
      const response = await fetch('/api/operations?type=scan');
      const body = await response.json();
      if (response.ok && body.operation && ['queued', 'running'].includes(body.operation.status)) {
        this.showOperation(body.operation);
        this.watchScanOperation(body.operation.id);
        return;
      }
      if (!reconcileMissing) return;
      // Operation IDs are process-local. After a restart, reconcile against
      // durable run/queue state before deciding whether submission is safe.
      const [durableRuns, durableQueue] = await Promise.all([
        this.api('/api/scan/runs'),
        this.api('/api/scan/queue'),
      ]);
      if (!durableRuns || !Array.isArray(durableRuns.runs)
        || !durableQueue || !Array.isArray(durableQueue.requests)) {
        throw new Error('durable scan state is invalid');
      }
      const activeRun = durableRuns.runs.some(
        (run) => !['complete', 'partial', 'abandoned', 'failed'].includes(run.state),
      );
      const queued = durableQueue.requests.some(
        (request) => ['queued', 'claimed', 'legacy-claimed'].includes(request.status),
      );
      if (activeRun || queued) {
        this.scanRunning = true;
        if (button) { button.disabled = true; button.textContent = 'Scanning…'; }
        await this.loadOpportunities({ durableRuns, durableQueue });
        this.scanOperationTimer = setTimeout(
          () => this.reattachScanOperation({ reconcileMissing: true }),
          1000,
        );
        return;
      }
      this.scanRunning = false;
      await this.loadOpportunities({ durableRuns, durableQueue });
      if (button) { button.disabled = false; button.textContent = 'Scan now'; }
    } catch {
      if (!reconcileMissing) return;
      this.scanRunning = true;
      if (button) { button.disabled = true; button.textContent = 'Scanning…'; }
      this.scanOperationTimer = setTimeout(
        () => this.reattachScanOperation({ reconcileMissing: true }),
        1000,
      );
    }
  },

  discoveryKey() {
    const c = this.workspaceConfig || {};
    return discoveryStorageKey([c.profile?.displayName, c.locale, c.timezone].filter(Boolean).join('|'));
  },

  acknowledgedDiscoveries() {
    try { return JSON.parse(localStorage.getItem(this.discoveryKey()) || '[]'); } catch { return []; }
  },

  queueStrongMatches() {
    this.discoveries = strongUnseenMatches(
      this.state.data?.opportunities,
      this.triagePolicy().actionScore,
      this.acknowledgedDiscoveries(),
    );
    if (!this.discoveries.length) return;
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => this.showStrongMatchArrival(), 700);
  },

  interfaceBusy() {
    const setup = document.getElementById('setup-overlay');
    const activeInput = document.activeElement;
    return (setup && !setup.classList.contains('hidden'))
      || !!this.chat?.streaming
      || !!activeInput?.matches?.('input, textarea, select');
  },

  uiReloadBlocker() {
    if (this.cvState.dirty) return 'Save or discard the open CV changes first.';
    if (this.chat?.streaming) return 'Wait for the current Scout response to finish first.';
    if (this.scanRunning) return 'Wait for the current scan to finish first.';
    if (Object.values(window.ScoutSetup?.operations || {}).some((operation) => ['queued', 'running'].includes(operation?.status))) {
      return 'Wait for the current Scout operation to finish first.';
    }
    if (window.ScoutSetup?.busy) return 'Wait for the current settings action to finish first.';
    if (document.getElementById('setup-overlay') && !document.getElementById('setup-overlay').classList.contains('hidden')) {
      return 'Close or finish the open Scout settings first.';
    }
    if (document.querySelector('.chat-drawer:not(.hidden), .cv-options-overlay:not(.hidden)')) {
      return 'Close the open panel first so typed work is not lost.';
    }
    return null;
  },

  showUiUpdate() {
    this.uiUpdateAvailable = true;
    const banner = document.getElementById('ui-update-banner');
    if (!banner) return;
    banner.replaceChildren();
    banner.classList.remove('hidden');
    const copy = document.createElement('p');
    copy.textContent = 'Scout has updated. Refresh this page to use the latest interface.';
    const actions = document.createElement('div');
    actions.className = 'update-banner-actions';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'act primary';
    refresh.textContent = 'Refresh Scout';
    refresh.addEventListener('click', () => this.refreshUpdatedUi(copy, refresh));
    actions.append(refresh);
    banner.append(copy, actions);
  },

  async refreshUpdatedUi(copy, button) {
    const blocker = this.uiReloadBlocker();
    if (blocker) {
      copy.textContent = `Scout is ready to update. ${blocker}`;
      return;
    }
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try { void this.serviceWorkerRegistration?.update?.(); } catch { /* the build handshake remains authoritative */ }
    location.reload();
  },

  async checkUiBuild() {
    try {
      const response = await fetch('/api/app-info', { cache: 'no-store' });
      const info = await response.json();
      if (response.ok && info.uiBuildId && this.uiBuildId && info.uiBuildId !== this.uiBuildId) this.showUiUpdate();
    } catch { /* host availability is reported by normal application requests */ }
  },

  async registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    try {
      let controlled = Boolean(navigator.serviceWorker.controller);
      const registration = await navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' });
      this.serviceWorkerRegistration = registration;
      const watch = (worker) => worker?.addEventListener?.('statechange', () => {
        if (worker.state === 'installed' && controlled) this.showUiUpdate();
      });
      registration.addEventListener?.('updatefound', () => watch(registration.installing));
      navigator.serviceWorker.addEventListener?.('controllerchange', () => {
        // The first controller is normal PWA installation, not an update. Only
        // a subsequent controller replacement should prompt for a refresh.
        if (controlled) this.showUiUpdate();
        controlled = true;
      });
    } catch { /* installed-app support never blocks the dashboard */ }
  },

  showStrongMatchArrival() {
    if (!this.discoveries.length) return;
    if (this.interfaceBusy()) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = setTimeout(() => this.showStrongMatchArrival(), 1500);
      return;
    }
    const first = this.discoveries[0];
    const count = this.discoveries.length;
    const el = document.getElementById('scout-arrival');
    el.innerHTML = `<div class="scout-arrival-copy scout-bubble tail-right" role="status" aria-live="polite">
        <b>${count === 1 ? 'I found a strong match' : `I found ${count} strong matches`}</b>
        <span>${this.esc(first.company)} — ${this.esc(first.role)} · ${this.esc(first.score)}</span>
        <div><button class="act primary" data-action="show-discovery">Show me</button><button class="act" data-action="dismiss-discoveries">Later</button></div>
      </div>${scoutMarkup('found', 'scout-arrival-character')}`;
    el.classList.remove('hidden');
    applyScoutState(el.querySelector('.scout-character'), 'found', { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  },

  acknowledgeDiscoveries() {
    const merged = mergeAcknowledged(this.acknowledgedDiscoveries(), this.discoveries);
    localStorage.setItem(this.discoveryKey(), JSON.stringify(merged));
    localStorage.setItem(`${this.discoveryKey()}.last`, new Date().toISOString());
  },

  dismissDiscoveries() {
    this.acknowledgeDiscoveries();
    this.discoveries = [];
    document.getElementById('scout-arrival').classList.add('hidden');
  },

  showDiscovery() {
    const first = this.discoveries[0];
    this.acknowledgeDiscoveries();
    document.getElementById('scout-arrival').classList.add('hidden');
    if (!first) return;
    this.showTab(this.tabForEntry(first));
    requestAnimationFrame(() => {
      const card = this.cardById(first.id);
      if (card) { this.expandCard(first.id, card); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    this.discoveries = [];
  },

  metaLine(e) {
    const bits = [e.location, e.salary, e.stage].filter((x) => x && x !== 'unknown');
    bits.push(this.categoryOf(e));
    const commute = this.commuteLine(e);
    if (commute) bits.push(commute);
    const current = this.currentStage(e);
    if (current) bits.push(`current: ${current}`);
    const checked = e.lastChecked ? ` - checked ${this.esc(e.lastChecked)}` : '';
    return this.esc(bits.join(' - ')) + checked;
  },

  tagHtml(e) {
    const id = this.categoryOf(e);
    const color = categoryColor(id, this.categoryIds());
    return `<span class="cat-tag" style="background:${color.bg};color:${color.fg}">${this.esc(this.categoryLabel(id))}</span>`;
  },
  tabForEntry(e) {
    if (this.isSpeculative(e)) return 'speculative';
    if (e.status === 'new') return 'jobs';
    if (e.status === 'shortlist') return 'shortlist';
    if (e.status === 'ignore') return 'all';
    return 'pipeline';
  },

  cardHtml(e, cls = '') {
    const score = typeof e.score === 'number' ? e.score : '-';
    const src = this.primarySource(e);
    const srcBtn = src
      ? `<a class="source-btn" href="${src}" target="_blank" rel="noopener">view source &#8599;</a>`
      : '';
    return `<div class="card ${cls}" data-id="${this.esc(e.id)}" role="button" tabindex="0">
      <div class="top">
        <span class="score ${this.fitClass(e.score)}">${this.esc(score)}</span>
        <b>${this.esc(e.company)} - ${this.esc(e.role)}</b>
        <span class="chip">${this.esc(e.status)}</span>
      </div>
      <div class="meta">${this.metaLine(e)}</div>
      ${srcBtn}
      <div class="detail"></div>
    </div>`;
  },

  filterBar() {
    const c = this.state.commute;
    const origin = this.workspaceConfig?.commute?.origin;
    const option = (value, label) => `<option value="${value}" ${String(c.mode) === value ? 'selected' : ''}>${label}</option>`;
    const maxOption = (value, label) => `<option value="${value}" ${String(c.maxMinutes) === String(value) ? 'selected' : ''}>${label}</option>`;
    return `<div class="filterbar">
      <b>Commute${origin ? ` from ${this.esc(origin)}` : ''}</b>
      <label>mode <select data-change-action="commute-filter" data-key="mode">
        ${option('either', 'Either')}${option('car', 'Car')}${option('public', 'Public transport')}${option('any', 'Any')}
      </select></label>
      <label>maximum <select data-change-action="commute-filter" data-key="maxMinutes" ${c.mode === 'any' ? 'disabled' : ''}>
        ${maxOption('30', '30 min')}${maxOption('60', '1 hour')}${maxOption('90', '1.5 hours')}${maxOption('120', '2 hours')}${maxOption('180', '3 hours')}
      </select></label>
      <label><input type="checkbox" ${c.includeUnknown ? 'checked' : ''} data-change-action="commute-filter" data-key="includeUnknown"> include unknown</label>
    </div>`;
  },

  setCommuteFilter(key, value) {
    this.state.commute[key] = value;
    this.renderJobs();
    this.renderSpeculative();
    this.renderShortlist();
    this.renderAll();
  },

  applyWorkspaceConfig(config, { render = true } = {}) {
    this.workspaceConfig = config || null;
    const commute = config?.commute;
    if (commute) {
      if (['either', 'car', 'public', 'any'].includes(commute.mode)) this.state.commute.mode = commute.mode;
      if (Number.isFinite(Number(commute.maxMinutes))) this.state.commute.maxMinutes = String(commute.maxMinutes);
      if (typeof commute.includeUnknown === 'boolean') this.state.commute.includeUnknown = commute.includeUnknown;
    }
    if (!this.state.data || !render) return;
    this.renderJobs();
    this.renderSpeculative();
    this.renderShortlist();
    this.renderAll();
  },

  triageCardHtml(e) {
    const score = typeof e.score === 'number' ? e.score : '-';
    const source = this.primarySource(e);
    const sourceLink = source
      ? `<a class="source-btn" href="${source}" target="_blank" rel="noopener">view source &#8599;</a>`
      : '';
    return `<div class="card triage-card" data-id="${this.esc(e.id)}" role="button" tabindex="0">
      <div class="chiprow">${this.tagHtml(e)}<span class="score ${this.fitClass(e.score)}">${this.esc(score)}</span></div>
      <div class="top"><b>${this.esc(e.company)} - ${this.esc(e.role)}</b></div>
      <div class="meta">${this.metaLine(e)}</div>
      ${sourceLink}
      <div class="detail"></div>
      <div class="triage-actions">
        <button class="act triage-no" data-action="triage-no" data-id="${this.esc(e.id)}">No</button>
        <button class="act" data-action="record-feedback" data-id="${this.esc(e.id)}">Feedback</button>
        <button class="act triage-yes" data-action="triage-yes" data-id="${this.esc(e.id)}">Yes, shortlist</button>
      </div>
    </div>`;
  },

  renderJobs() {
    if (!this.state.data) return;
    const target = document.getElementById('tab-jobs');
    if (!target) return;
    const entries = this.filteredEntries('all')
      .filter((e) => e.status === 'new' && !this.isSpeculative(e))
      .sort((a, b) => (typeof b.score === 'number' ? b.score : -1) - (typeof a.score === 'number' ? a.score : -1));
    const list = entries.length
      ? entries.map((e) => this.triageCardHtml(e)).join('')
      : (this.latestScanCard() || '<p class="inbox-empty">All caught up - nothing new to review.</p>');
    target.innerHTML = this.filterBar()
      + `<div class="label">${entries.length} new job${entries.length === 1 ? '' : 's'} to review</div>`
      + list;
    this.updateJobsBadge(entries.length);
  },

  renderSpeculative() {
    if (!this.state.data) return;
    const target = document.getElementById('tab-speculative');
    if (!target) return;
    const entries = this.filteredEntries('all')
      .filter((e) => this.isSpeculative(e))
      .sort((a, b) => (typeof b.score === 'number' ? b.score : -1) - (typeof a.score === 'number' ? a.score : -1));
    const groups = [
      ['New', entries.filter((e) => e.status === 'new')],
      ['Shortlisted', entries.filter((e) => e.status === 'shortlist')],
      ['Watch', entries.filter((e) => e.status === 'watch')],
      ['Active', entries.filter((e) => ['outreach', 'applied', 'interviewing'].includes(e.status))],
      ['Closed', entries.filter((e) => ['accepted', 'rejected', 'ignore'].includes(e.status))],
    ];
    const list = groups
      .filter(([, items]) => items.length)
      .map(([label, items]) => `<div class="label">${label} (${items.length})</div>${items.map((e) => this.cardHtml(e)).join('')}`)
      .join('');
    target.innerHTML = this.filterBar()
      + `<div class="label">Speculative opportunities (${entries.length})</div>`
      + (list || '<p class="inbox-empty">No speculative opportunities match the current commute filter.</p>');
  },

  updateJobsBadge(count) {
    const badge = document.getElementById('jobs-count');
    if (!badge) return;
    badge.textContent = count ? String(count) : '';
    badge.classList.toggle('hidden', !count);
  },

  triageYes(id) { this.post('/api/status', { id, status: 'shortlist' }); },
  async triageNo(id) {
    const entry = this.state.data?.opportunities?.find((item) => item.id === id);
    if (!entry || entry.status !== 'new') return;

    // Respond to the decision immediately instead of leaving the card in place
    // while the tracker write and opportunities refresh complete.
    entry.status = 'ignore';
    this.renderJobs();

    const result = await this.post('/api/status', { id, status: 'ignore' });
    if (result?.ok) {
      this.showUndo(id);
      return result;
    }

    // A failed write must put the job back rather than leave optimistic state
    // that disagrees with the tracker.
    const current = this.state.data?.opportunities?.find((item) => item.id === id);
    if (current?.status === 'ignore') {
      current.status = 'new';
      this.renderJobs();
    }
    return result;
  },
  undoDismiss(id) { this.post('/api/status', { id, status: 'new' }).then(() => this.hideUndo()); },
  restoreEntry(id) { this.post('/api/status', { id, status: 'new' }); },

  showUndo(id) {
    const toast = document.getElementById('undo-toast');
    if (!toast) return;
    toast.innerHTML = `<span>${this.esc(this.company(id))} dismissed</span>`
      + `<button data-action="undo-dismiss" data-id="${this.esc(id)}">Undo</button>`;
    toast.classList.remove('hidden');
    window.clearTimeout?.(this.undoTimer);
    this.undoTimer = window.setTimeout?.(() => this.hideUndo(), 6000);
  },
  hideUndo() {
    window.clearTimeout?.(this.undoTimer);
    document.getElementById('undo-toast')?.classList.add('hidden');
  },

  shortlistCardHtml(e) {
    const score = typeof e.score === 'number' ? e.score : '-';
    return `<div class="card" data-id="${this.esc(e.id)}" role="button" tabindex="0">
      <div class="chiprow">${this.tagHtml(e)}<span class="score ${this.fitClass(e.score)}">${this.esc(score)}</span></div>
      <div class="top"><b>${this.esc(e.company)} - ${this.esc(e.role)}</b></div>
      <div class="meta">${this.metaLine(e)}</div>
      <div class="detail"></div>
      <div class="triage-actions">
        <button class="act triage-no" data-action="remove-shortlist" data-id="${this.esc(e.id)}">Remove</button>
        <button class="act bridge" data-action="choose-cv-options" data-id="${this.esc(e.id)}">Review CV options</button>
      </div>
    </div>`;
  },

  renderShortlist() {
    if (!this.state.data) return;
    const target = document.getElementById('tab-shortlist');
    if (!target) return;
    const entries = this.filteredEntries('all')
      .filter((e) => e.status === 'shortlist')
      .sort((a, b) => (typeof b.score === 'number' ? b.score : -1) - (typeof a.score === 'number' ? a.score : -1));
    const list = entries.length
      ? entries.map((e) => this.shortlistCardHtml(e)).join('')
      : '<p class="inbox-empty">Nothing shortlisted yet. Tap "Yes" on a job to add it here.</p>';
    target.innerHTML = this.filterBar()
      + `<div class="label">Shortlist (${entries.length})</div>`
      + list;
  },

  removeFromShortlist(id) { this.post('/api/status', { id, status: 'ignore' }).then((r) => { if (r && r.ok) this.showUndo(id); }); },

  renderPipeline() {
    if (!this.state.data) return;
    // A pre-update server can answer with an older pipeline shape. Render an
    // empty board rather than throwing, which would abort loadOpportunities()
    // before the dashboard and discovery prompts are drawn.
    const p = this.state.data.pipeline;
    const el = document.getElementById('tab-pipeline');
    if (!p || !el) return;
    const metric = (label, value) => `<div class="metric"><b>${this.esc(value)}</b>${this.esc(label)}</div>`;
    const list = (title, status, items, hint = '') => `<section class="pipeline-column" data-pipeline-status="${this.esc(status)}">
      <div class="label">${title}</div>
      ${hint ? `<div class="meta pipeline-column-hint">${this.esc(hint)}</div>` : ''}
      ${items.length ? items.map((i) => this.pipelineCard(i)).join('') : '<p>Nothing here.</p>'}
    </section>`;
    el.innerHTML = `
      <div class="metrics">
        ${metric('shortlist', p.summary.shortlist ?? (p.shortlist || []).length)}
        ${metric('watch', p.summary.watch ?? (p.watch || []).length)}
        ${metric('active', p.summary.active)}
        ${metric('accepted', p.summary.accepted ?? (p.accepted || []).length)}
        ${metric('closed', p.summary.recentlyClosed)}
      </div>
      <p class="meta pipeline-drag-help">Drag a card into another column to update its status. Drop into Jobs to return it to the inbox.</p>
      <div class="split pipeline-board">
        ${list('Jobs', 'new', [], 'Return to the Jobs inbox')}
        ${list('Shortlist', 'shortlist', p.shortlist || [])}
        ${list('Watch', 'watch', p.watch || [])}
        ${list('Active', 'outreach', p.active, 'Starts at outreach')}
        ${list('Accepted', 'accepted', p.accepted || [])}
        ${list('Closed', 'rejected', p.recentlyClosed)}
      </div>`;
  },

  movePipelineEntry(id, status) {
    const entry = this.state.data?.opportunities?.find((item) => item.id === id);
    if (!entry || entry.status === status) return Promise.resolve({ ok: true, unchanged: true });
    if (status === 'outreach' && ['outreach', 'applied', 'interviewing'].includes(entry.status)) {
      return Promise.resolve({ ok: true, unchanged: true });
    }
    return this.post('/api/status', { id, status });
  },

  async openScanResult() {
    if (!this.latestScan) this.latestScan = (await this.api('/api/scans/latest')).scan;
    const scan = this.latestScan;
    if (!scan) return;
    const labels = { kept: 'Kept', hard_exclusion: 'Hard exclusions', mandatory_unmet: 'Mandatory gates', below_threshold: 'Below threshold', provider_discarded: 'Assessment discards' };
    const reasonLabels = {
      'advert-closed': 'The advert was no longer live when Scout checked it.',
      'assessment-capacity': 'It cleared the relevance threshold, but the detailed-assessment capacity was already full.',
      'assessment-failed': 'Scout selected it, but its bounded assessment did not complete successfully.',
      'below-relevance-threshold': 'Its deterministic relevance score was below the configured assessment threshold.',
      'diversity-limit': 'A stronger mix of employers, sources, role families, lanes or locations filled the assessment set.',
      'exploration-replacement': 'A seeded exploration place replaced this deterministic selection.',
      'unchanged-rejection': 'The advert and profile were unchanged since the previous rejection, so Scout did not repeat the assessment.',
      'unchanged-prior-assessment': 'The advert and profile were unchanged since the previous assessment.',
      'verification-scope': 'This verification pass was limited to vacancies requiring a second assessment.',
    };
    const reasonText = (code) => reasonLabels[code]
      || String(code || 'not-selected').replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
    const groups = Object.entries(labels).map(([outcome, label]) => {
      const items = (scan.reviewed || []).filter((item) => item.outcome === outcome).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      if (!items.length) return '';
      return `<details ${outcome !== 'kept' ? 'open' : ''}><summary>${this.esc(label)} (${items.length})</summary><div class="scan-review-list">${items.map((item) => `<article class="scan-review-item"><div><b>${this.esc(item.company)} — ${this.esc(item.role)}</b><span class="chip">${this.esc(item.score ?? '—')}</span></div><p>${this.esc((item.reasons || []).join('; ') || label)}</p>${item.sourceUrl ? `<a href="${this.safeHref(item.sourceUrl)}" target="_blank" rel="noopener">View source ↗</a>` : ''}</article>`).join('')}</div></details>`;
    }).join('');
    const coverageSources = (scan.coverage?.source || []).map((item) => (
      `<article class="scan-review-item"><div><b>${this.esc(item.value)}</b><span class="chip">${this.esc(item.assessed)} assessed</span></div><p>${this.esc(`${item.found} found · ${item.ranked} ranked · ${item.selected} selected · ${item.excluded} excluded`)}</p></article>`
    )).join('');
    const coverage = coverageSources ? `<details><summary>Coverage by source (${scan.coverage.source.length})</summary><div class="scan-review-list">${coverageSources}</div></details>` : '';
    const coverageDimensionLabels = {
      employer: 'employer', lane: 'lane', roleFamily: 'role family', location: 'location',
      provider: 'provider', run: 'run', date: 'date',
    };
    const coverageDimensions = Object.entries(coverageDimensionLabels).map(([dimension, label]) => {
      const items = scan.coverage?.[dimension] || [];
      if (!items.length) return '';
      return `<details><summary>Coverage by ${this.esc(label)} (${items.length})</summary><div class="scan-review-list">${items.map((item) => `<article class="scan-review-item"><div><b>${this.esc(item.value)}</b><span class="chip">${this.esc(item.assessed)} assessed</span></div><p>${this.esc(`${item.found} found · ${item.ranked} ranked · ${item.selected} selected · ${item.excluded} excluded`)}</p></article>`).join('')}</div></details>`;
    }).join('');
    const failureReasons = (scan.coverage?.failureReasons || []).length
      ? `<details><summary>Coverage failures (${scan.coverage.failureReasons.length})</summary><div class="scan-review-list">${scan.coverage.failureReasons.map((item) => `<article class="scan-review-item"><div><b>${this.esc(reasonText(item.value))}</b><span class="chip">${this.esc(item.count)}</span></div></article>`).join('')}</div></details>`
      : '';
    const missed = (scan.explanations || []).filter((item) => (
      item.stages?.excluded || (item.stages?.ranked && !item.stages?.selected)
    )).sort((left, right) => (
      Number(right.aboveThreshold) - Number(left.aboveThreshold)
      || Number(right.preRank?.score || 0) - Number(left.preRank?.score || 0)
    ));
    const missedGroup = missed.length ? `<details open><summary>Why roles missed detailed assessment (${missed.length})</summary><div class="scan-review-list">${missed.map((item) => `<article class="scan-review-item scan-explanation-item"><div><b>${this.esc(item.company || item.dimensions?.employer || 'Unknown employer')} — ${this.esc(item.role || 'Unknown role')}</b><span class="chip">${this.esc(item.preRank?.score ?? '—')}</span></div><p>${this.esc(reasonText(item.reasonCode))}</p><p class="meta">${this.esc([item.dimensions?.source, item.dimensions?.lane, item.dimensions?.roleFamily, item.dimensions?.location].filter(Boolean).join(' · '))}</p>${item.sourceUrl ? `<a href="${this.safeHref(item.sourceUrl)}" target="_blank" rel="noopener">View source ↗</a>` : ''}</article>`).join('')}</div></details>` : '';
    const overlay = document.getElementById('scan-result-overlay');
    document.getElementById('scan-result-body').innerHTML = `
      <p><strong>${this.esc(scan.funnel?.assessed ?? scan.candidatesFound)} assessed, ${this.esc(scan.keepersAdded)} kept</strong>${this.discardBreakdown(scan) ? ` — ${this.esc(this.discardBreakdown(scan))}` : ''}.</p>
      ${scan.automaticBroadened ? '<div class="setup-callout"><strong>Discovery widened automatically</strong><p>Scout ran one broader query pass but kept every approved salary, location, commute, exclusion and evidence gate.</p></div>' : ''}
      ${coverage}
      ${coverageDimensions}
      ${failureReasons}
      ${missedGroup}
      ${groups || (!missedGroup ? '<p class="meta">This older scan contains aggregate totals only. Run a new scan for candidate-level explanations.</p>' : '')}
      <div class="controls">${scan.reportDate ? `<button class="act" data-action="open-scan-report" data-date="${this.esc(scan.reportDate)}">Open dated report</button>` : ''}<button class="act" data-action="close-scan-result">Close</button></div>`;
    overlay.classList.remove('hidden');
    ScoutModal.focus(overlay, '#scan-result-title');
  },

  closeScanResult() { document.getElementById('scan-result-overlay')?.classList.add('hidden'); },

  pipelineCard(item) {
    const entry = this.state.data.opportunities.find((o) => o.id === item.id) || item;
    const bits = [
      item.currentStage ? `stage: ${item.currentStage}` : null,
      item.appliedDate ? `applied ${item.appliedDate}` : null,
      item.daysSinceLastMovement !== null ? `${item.daysSinceLastMovement}d since movement` : null,
    ].filter(Boolean).join(' - ');
    return `<div class="card pipeline-card" data-id="${this.esc(item.id)}" data-status="${this.esc(item.status)}" draggable="true" role="button" tabindex="0">
      <div class="top"><span class="score ${this.fitClass(item.score)}">${this.esc(item.score ?? '-')}</span><b>${this.esc(item.company)} - ${this.esc(item.role)}</b><span class="chip">${this.esc(item.status)}</span></div>
      <div class="meta">${this.esc(bits) || this.metaLine(entry)}</div>
      <div class="detail"></div>
    </div>`;
  },

  renderAll() {
    if (!this.state.data) return;
    const rowsHtml = () => {
      const { key, dir } = this.state.sort;
      const q = this.state.filter.toLowerCase();
      let rows = this.filteredEntries('all');
      if (q) rows = rows.filter((e) => `${e.company} ${e.role} ${(e.tags || []).join(' ')}`.toLowerCase().includes(q));
      rows.sort((a, b) => {
        const av = a[key] ?? (key === 'score' ? -1 : '');
        const bv = b[key] ?? (key === 'score' ? -1 : '');
        return av < bv ? dir : av > bv ? -dir : 0;
      });
      return rows.map((e) => `<tr data-action="open-entry" data-tab="${this.esc(this.tabForEntry(e))}" data-id="${this.esc(e.id)}" role="button" tabindex="0" style="cursor:pointer">
        <td><b>${typeof e.score === 'number' ? e.score : '-'}</b></td>
        <td>${this.esc(e.company)}</td><td>${this.esc(e.role)}</td>
        <td>${this.esc(this.categoryOf(e))}</td>
        <td>${this.esc(this.commuteMinutes(e, 'car') ?? '-')}</td>
        <td>${this.esc(this.commuteMinutes(e, 'public') ?? '-')}</td>
        <td>${this.esc(this.currentStage(e) || '-')}</td>
        <td>${this.esc(e.status)}${e.status === 'ignore' ? ` <button class="act min" data-action="restore" data-id="${this.esc(e.id)}">Restore</button>` : ''}</td><td>${this.esc(e.lastChecked || 'never')}</td></tr>`).join('');
    };
    document.getElementById('tab-all').innerHTML =
      `${this.filterBar()}
       <div class="controls"><input id="filter" placeholder="search company / role / tag..." value="${this.esc(this.state.filter)}"></div>
       <div class="all-table-scroll" role="region" aria-label="All opportunities table" tabindex="0"><table><thead><tr>
         <th data-action="sort" data-key="score" role="button" tabindex="0">score</th>
         <th data-action="sort" data-key="company" role="button" tabindex="0">company</th>
         <th>role</th>
         <th>category</th>
         <th>car</th>
         <th>public</th>
         <th>stage</th>
         <th data-action="sort" data-key="status" role="button" tabindex="0">status</th>
         <th data-action="sort" data-key="lastChecked" role="button" tabindex="0">last checked</th>
       </tr></thead><tbody id="all-table-body">${rowsHtml()}</tbody></table></div>`;
    const f = document.getElementById('filter');
    if (f) f.addEventListener('input', (event) => {
      this.state.filter = event.target.value;
      const body = document.getElementById('all-table-body');
      if (body) body.innerHTML = rowsHtml();
    });
  },

  setSort(key) {
    const s = this.state.sort;
    s.dir = s.key === key ? -s.dir : (key === 'company' || key === 'status' ? 1 : -1);
    s.key = key;
    this.renderAll();
  },

  async renderReports() {
    const { reports } = await this.api('/api/reports');
    const el = document.getElementById('tab-reports');
    const scanHealth = this.scanHealthCard();
    if (!reports.length) { el.innerHTML = `${scanHealth}<p>No reports yet.</p>`; return; }
    el.innerHTML = `${scanHealth}<div class="report-list">
      <label class="report-date-select">Report date<select data-action="select-report">${reports.map((d) => `<option value="${this.esc(d)}">${d}</option>`).join('')}</select></label>
      <nav class="dates" aria-label="Report dates">${reports.map((d) => `<button class="act" data-action="open-report" data-date="${this.esc(d)}">${d}</button>`).join('')}</nav>
      <div id="report-body" class="report-body" style="flex:1"></div></div>`;
    await this.openReport(reports[0]);
  },

  async openReport(date) {
    const md = await this.api(`/api/reports/${date}`);
    const body = document.getElementById('report-body');
    body.innerHTML = globalThis.ScoutReportView?.render(md) || `<pre class="report-fallback">${this.esc(md)}</pre>`;
    body.querySelector('#daily-report-title')?.focus({ preventScroll: true });
    const select = document.querySelector('.report-date-select select');
    if (select) select.value = date;
    document.querySelectorAll('.report-list .dates button').forEach((b) => {
      b.classList.toggle('active', b.dataset.date === date);
      b.setAttribute('aria-current', b.dataset.date === date ? 'date' : 'false');
    });
  },

  async openScanReport(date) {
    this.showTab('reports');
    await this.renderReports();
    return this.openReport(date);
  },

  openEntry(tab, id) {
    this.showTab(tab);
    const card = this.cardById(id);
    if (!card) return;
    this.expandCard(id, card, true);
    card.scrollIntoView({ block: 'nearest' });
  },

  expandCard(id, clickedCard = null, forceOpen = false) {
    const card = clickedCard || this.cardById(id);
    if (!card) return;
    if (forceOpen) card.classList.add('open');
    else card.classList.toggle('open');
    const e = this.state.data.opportunities.find((o) => o.id === id);
    const box = card.querySelector('.detail');
    if (e && box && !box.dataset.filled) {
      box.innerHTML = this.detailHtml(e);
      box.dataset.filled = '1';
    }
  },

  async toggleSourcePanel(id, btn) {
    const body = btn.closest('.source-panel').querySelector('.source-body');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    btn.textContent = open ? 'show what the source says' : 'hide source text';
    if (open || body.dataset.loaded) return;
    body.innerHTML = '<div class="meta">fetching source…</div>';
    let r;
    try { r = await this.api(`/api/source?id=${encodeURIComponent(id)}`); }
    catch { r = { ok: false, error: 'request failed' }; }
    body.dataset.loaded = '1';
    body.innerHTML = this.sourceBodyHtml(r);
  },

  sourceBodyHtml(r) {
    const fallback = `<div class="meta">couldn't read this page - open the source instead`;
    if (!r || typeof r !== 'object' || r.ok !== true) {
      const reason = r && r.error ? ` (${this.esc(r.error)})` : '';
      return `${fallback}${reason}</div>`;
    }
    let host = '';
    try { host = new URL(r.url).hostname; } catch { /* leave blank */ }
    const stamp = `<div class="meta">fetched ${this.esc(new Date(r.fetchedAt).toLocaleTimeString())}${host ? ` from ${this.esc(host)}` : ''}</div>`;
    const factLabels = {
      title: 'title', salary: 'salary', location: 'location',
      employmentType: 'type', workMode: 'work mode',
      datePosted: 'posted', validThrough: 'closes',
    };
    const facts = Object.entries(factLabels)
      .filter(([key]) => r.facts && r.facts[key])
      .map(([key, label]) => `<div class="meta"><b>${label}</b> ${this.esc(r.facts[key])}</div>`)
      .join('');
    const thin = r.thin ? `${fallback} - the page returned very little text</div>` : '';
    const text = r.text ? `<div class="source-text">${this.esc(r.text)}</div>` : '';
    return stamp
      + (facts || '<div class="meta">no key facts found on the page</div>')
      + thin + text;
  },

  detailHtml(e) {
    const bd = e.scoreBreakdown || {};
    const bars = ['technical', 'sector', 'upside', 'comp', 'location', 'acceleration', 'credibility']
      .filter((k) => k in bd)
      .map((k) => `<div class="meta">${k} <span style="width:${(bd[k] || 0) * 6}px"></span> ${bd[k]}</div>`)
      .join('');
    const tags = (e.tags || []).length
      ? `<div class="chip-list">${(e.tags || []).map((t) => `<span class="chip">${this.esc(t)}</span>`).join('')}</div>`
      : '';
    const contacts = (e.contacts || []).length
      ? e.contacts.map((c) => {
          const linkedin = this.safeHref(c.linkedin);
          return `<div class="meta">${this.esc(c.name)}${c.role ? ' - ' + this.esc(c.role) : ''}${linkedin ? ` - <a href="${linkedin}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</div>`;
        }).join('')
      : '<div class="meta">no contacts yet</div>';
    const log = (e.log || []).length
      ? e.log.map((l) => `<div class="meta">${this.esc(l.date)} - ${this.esc(l.event)}${l.note ? ': ' + this.esc(l.note) : ''}</div>`).join('')
      : '<div class="meta">no events yet</div>';
    const stages = this.stages(e);
    const commute = e.commute || {};
    const commuteHtml = this.commuteLine(e)
      ? `<div class="meta">${this.esc(this.commuteLine(e))}${commute.destination ? ' - ' + this.esc(commute.destination) : ''}${commute.checked ? ' - checked ' + this.esc(commute.checked) : ''}${commute.notes ? '<br>' + this.esc(commute.notes) : ''}</div>`
      : '<div class="meta">no commute time recorded yet</div>';
    const stageHtml = stages.length
      ? `<ol class="stage-list">${stages.map((s, i) =>
          `<li>${this.esc(s.completed ? '[x]' : '[ ]')} ${this.esc(s.name)}${s.date ? ' - ' + this.esc(s.date) : ''}${!s.completed ? ` <button class="act" data-action="complete-stage" data-id="${this.esc(e.id)}" data-index="${i}">complete</button>` : ''}</li>`).join('')}</ol>`
      : '<div class="meta">no application stages yet</div>';
    const slug = this.resolveArtifactFor(e).slug;
    const cvFiles = this.state.cvFiles || { applications: [], outreach: [] };
    const hasCv = (cvFiles.applications || []).includes(slug);
    const hasOutreach = (cvFiles.outreach || []).includes(slug);
    const applied = ['applied', 'interviewing', 'accepted'].includes(e.status);
    const prepRecommended = this.interviewPrepRecommended(e.id);
    const extraSources = (e.sources || []).slice(1)
      .map((s) => this.safeHref(s)).filter(Boolean)
      .map((href, i) => `<a href="${href}" target="_blank" rel="noopener">source ${i + 2}</a>`)
      .join(' - ');
    const sourcePanel = this.primarySource(e)
      ? `<div class="label">source</div>
         <div class="source-panel">
           <button class="act" data-action="toggle-source" data-id="${this.esc(e.id)}">show what the source says</button>
           ${extraSources ? `<span class="meta"> ${extraSources}</span>` : ''}
           <div class="source-body" style="display:none"></div>
         </div>`
      : '';
    return `
      ${sourcePanel}
      <div class="label">score breakdown (read-only)</div>${bars || '<div class="meta">not scored yet</div>'}
      <div class="label">tags</div>${tags || '<div class="meta">-</div>'}
      <div class="label">category</div><div class="meta">${this.esc(this.categoryOf(e))}</div>
      <div class="label">commute</div>${commuteHtml}
      <div class="label">contacts</div>${contacts}
      <div class="label">application stages</div>${stageHtml}
      <div class="label">event log</div>${log}
      <div class="label">notes</div><div class="meta" style="white-space:pre-wrap">${this.esc(e.notes || '-')}</div>
      <div class="controls" style="margin-top:10px;flex-wrap:wrap">
        ${applied ? '' : `<button class="act" data-action="mark-applied" data-id="${this.esc(e.id)}">mark applied</button>`}
        <button class="act" data-action="mark-accepted" data-id="${this.esc(e.id)}">mark accepted</button>
        <button class="act" data-action="mark-rejected" data-id="${this.esc(e.id)}">mark rejected</button>
        ${hasCv
          ? `<button class="act" data-action="see-cv" data-slug="${this.esc(slug)}" data-id="${this.esc(e.id)}">see custom CV</button>`
          : `<button class="act bridge" data-action="choose-cv-options" data-id="${this.esc(e.id)}">create custom CV</button>`}
        ${hasOutreach
          ? `<button class="act" data-action="see-cover-letter" data-slug="${this.esc(slug)}">see cover letter</button>`
          : `<button class="act bridge" data-action="open-chat" data-id="${this.esc(e.id)}" data-prefill="coverLetter">create custom cover letter</button>`}
        <button class="act" data-action="open-company-history" data-id="${this.esc(e.id)}">company history</button>
        <button class="act" data-action="record-feedback" data-id="${this.esc(e.id)}">record feedback</button>
        <button class="act bridge" data-action="open-chat" data-id="${this.esc(e.id)}" data-prefill="fit">fit and evidence gaps</button>
        <button class="act bridge" data-action="open-chat" data-id="${this.esc(e.id)}" data-prefill="ask">ask about this job</button>
        <button class="act${prepRecommended ? ' bridge' : ''}" data-action="open-interview-prep" data-id="${this.esc(e.id)}">interview prep</button>
      </div>`;
  },

  async recordJobFeedback(id, presetDecision = null) {
    const decisions = [
      'applied', 'interview', 'promising', 'saved', 'rejected',
      'not-interested', 'duplicate', 'already-seen',
    ];
    const reasons = [
      'location', 'salary', 'seniority', 'responsibilities', 'employer',
      'role-family', 'other', 'positive', 'duplicate', 'already-seen',
    ];
    const decision = presetDecision || window.prompt?.(
      `Decision (${decisions.join(', ')}):`,
      'not-interested',
    );
    if (!decisions.includes(decision)) return null;
    const reason = window.prompt?.(`Reason (${reasons.join(', ')}):`, decision === 'promising' ? 'positive' : 'other');
    if (!reasons.includes(reason)) return null;
    const explanation = window.prompt?.('Explain this job-specific feedback:', '');
    if (!String(explanation || '').trim()) return null;
    if (!this.feedbackLearning?.revision) {
      this.feedbackLearning = await this.api('/api/feedback-learning');
    }
    const result = await this.api('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: this.feedbackLearning.revision,
        opportunityId: id,
        decision,
        reason,
        explanation: String(explanation).trim(),
      }),
    });
    if (result?.ok) {
      this.feedbackLearning = result.ledger;
      window.alert?.('Job feedback recorded. Ranking did not change; any learned preference must be proposed and reviewed in Settings.');
    }
    return result;
  },

  async post(pathname, payload, { retryTrackerConflict = true } = {}) {
    const trackerMutation = new Set([
      '/api/status', '/api/note', '/api/log', '/api/contact', '/api/category',
      '/api/commute', '/api/applied', '/api/rejected', '/api/stage', '/api/stage/complete',
    ]).has(pathname);
    const requestPayload = trackerMutation
      ? { ...payload, trackerRevision: this.state.data?.trackerRevision }
      : payload;
    const r = await this.api(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    if (trackerMutation && r?.conflict && retryTrackerConflict) {
      await this.loadOpportunities();
      return this.post(pathname, payload, { retryTrackerConflict: false });
    }
    if (r && r.ok) {
      const activeTab = this.state.tab;
      await this.loadOpportunities();
      this.showTab(activeTab);
      if (payload.id && this.cardById(payload.id)) this.expandCard(payload.id, this.cardById(payload.id), true);
    } else {
      alert(`Failed: ${(r && r.error) || 'unknown error'}`);
    }
    return r;
  },

  markApplied(id) { this.post('/api/applied', { id, note: '' }); },
  markAccepted(id) {
    if (confirm('Mark this opportunity as accepted?')) this.post('/api/status', { id, status: 'accepted' });
  },
  rejectOpportunity(id) {
    if (confirm('Mark this opportunity as rejected?')) this.post('/api/rejected', { id, note: 'Rejected / closed out.' });
  },
  completeStage(id, index) { this.post('/api/stage/complete', { id, index }); },

  company(id) {
    if (id === 'setup-onboarding') return 'Scout setup';
    const e = (this.state.data?.opportunities || []).find((o) => o.id === id);
    return e ? e.company : id;
  },

  slugOf(company) {
    return String(company || '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },

  artifactSlugFor(entry) { return artifactSlugFor(entry); },
  resolveArtifactFor(entry) {
    return resolveArtifact(
      this.state.cvFiles?.applications || [],
      entry,
      (company) => this.slugOf(company),
      this.state.data?.opportunities || [],
    );
  },

  localToday() {
    const value = new Date();
    value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
    return value.toISOString().slice(0, 10);
  },

  async openCompanyHistory(id) {
    if (this.chat?.streaming) return alert('Finish or stop the running Scout turn before opening company history.');
    await this.closeChat();
    let data;
    try { data = await this.api(`/api/company?id=${encodeURIComponent(id)}`); }
    catch (error) { return alert(`Could not open company history: ${error.message}`); }
    if (data?.error) return alert(`Could not open company history: ${data.error}`);
    this.companyHistory = { id, data };
    this.renderCompanyHistory();
  },

  closeCompanyHistory() {
    this.companyHistory = null;
    document.getElementById('company-drawer')?.classList.add('hidden');
  },

  companyRoleLabel(id) {
    const role = this.companyHistory?.data?.opportunities?.find((entry) => entry.id === id);
    return role?.role || id;
  },

  companyContactLabel(id) {
    const contact = this.companyHistory?.data?.contacts?.find((entry) => entry.id === id);
    return contact?.name || '';
  },

  companyTimelineItemHtml(item) {
    const contact = this.companyContactLabel(item.contactId);
    const roleNames = (item.opportunityIds || []).map((id) => this.companyRoleLabel(id));
    const labels = [item.kind, item.direction !== 'note' ? item.direction : null, item.channel !== 'other' ? item.channel : null]
      .filter(Boolean).join(' · ');
    const roleLine = roleNames.length ? `<div class="meta">${this.esc(roleNames.join(' · '))}</div>` : '';
    const contactLine = contact ? `<b>${this.esc(contact)}</b> · ` : '';
    const remove = item.source === 'company'
      ? `<button class="danger-link company-remove" type="button" data-action="remove-company-communication" data-id="${this.esc(item.id)}">remove</button>`
      : '<span class="chip">tracker</span>';
    return `<article class="company-event ${this.esc(item.direction || 'note')}">
      <div class="company-event-head"><span>${this.esc(item.date)}</span><span>${contactLine}${this.esc(labels)}</span>${remove}</div>
      ${roleLine}<div class="company-event-text">${this.esc(item.text)}</div>
    </article>`;
  },

  renderCompanyHistory() {
    const state = this.companyHistory;
    const drawer = document.getElementById('company-drawer');
    if (!state || !drawer) return drawer?.classList.add('hidden');
    const data = state.data;
    const roles = (data.opportunities || []).map((entry) => `
      <div class="company-role">
        <div><b>${this.esc(entry.role)}</b><span class="chip">${this.esc(entry.status || 'new')}</span></div>
        <div class="meta">${this.esc([entry.location, entry.appliedDate ? `applied ${entry.appliedDate}` : '', entry.currentStage ? `current: ${entry.currentStage}` : ''].filter(Boolean).join(' · '))}</div>
        <button class="act bridge" type="button" data-action="open-company-role-chat" data-id="${this.esc(entry.id)}">open job chat</button>
      </div>`).join('');
    const contacts = (data.contacts || []).length
      ? data.contacts.map((contact) => {
          const href = this.safeHref(contact.linkedin);
          return `<div class="company-contact"><b>${this.esc(contact.name)}</b>${contact.role ? `<span>${this.esc(contact.role)}</span>` : ''}${href ? `<a href="${href}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</div>`;
        }).join('')
      : '<div class="meta">No company contacts recorded yet.</div>';
    const timeline = (data.timeline || []).length
      ? data.timeline.map((item) => this.companyTimelineItemHtml(item)).join('')
      : '<div class="meta">No company activity recorded yet.</div>';
    const opportunityOptions = [
      '<option value="">Company-wide</option>',
      ...(data.opportunities || []).map((entry) => `<option value="${this.esc(entry.id)}" ${entry.id === state.id ? 'selected' : ''}>${this.esc(entry.role)}</option>`),
    ].join('');
    drawer.innerHTML = `
      <div class="chat-head">
        <div><b>${this.esc(data.company)}</b><div class="meta">company relationship history</div></div>
        <button class="act" style="margin-left:auto" type="button" data-action="close-company-history">close</button>
      </div>
      <div class="company-body">
        <div class="label">Related roles</div>${roles}
        <div class="label">Contacts</div>${contacts}
        <div class="label">Activity and correspondence</div>${timeline}
        <form class="company-form" data-submit-action="save-company-communication">
          <div class="label">Record an update</div>
          <div class="company-form-grid">
            <label>Date<input id="company-event-date" type="date" value="${this.localToday()}" required></label>
            <label>Role<select id="company-event-opportunity">${opportunityOptions}</select></label>
            <label>Type<select id="company-event-kind"><option value="message">Message</option><option value="call">Call</option><option value="meeting">Meeting</option><option value="interview">Interview</option><option value="application">Application</option><option value="note">Note</option></select></label>
            <label>Direction<select id="company-event-direction"><option value="inbound">Received</option><option value="outbound">Sent</option><option value="note">Note</option></select></label>
            <label>Channel<select id="company-event-channel"><option value="linkedin">LinkedIn</option><option value="email">Email</option><option value="phone">Phone</option><option value="video">Video call</option><option value="in-person">In person</option><option value="other">Other</option></select></label>
            <label>Contact<input id="company-event-contact" placeholder="e.g. Julian Sheppard"></label>
            <label>Contact role<input id="company-event-contact-role" placeholder="e.g. Lead Talent Acquisition Partner"></label>
            <label>Contact link<input id="company-event-contact-link" type="url" placeholder="https://linkedin.com/in/..."></label>
          </div>
          <label>Message or notes<textarea id="company-event-text" placeholder="Paste the message verbatim, or record what happened." required></textarea></label>
          <div class="company-privacy">Saved only in your private Scout workspace. Scout never sends this message.</div>
          <button class="act primary" type="submit">save to company history</button>
        </form>
      </div>`;
    drawer.classList.remove('hidden');
  },

  async saveCompanyCommunication() {
    const state = this.companyHistory;
    if (!state) return;
    const opportunityId = document.getElementById('company-event-opportunity').value;
    const communication = {
      date: document.getElementById('company-event-date').value,
      kind: document.getElementById('company-event-kind').value,
      direction: document.getElementById('company-event-direction').value,
      channel: document.getElementById('company-event-channel').value,
      opportunityIds: opportunityId ? [opportunityId] : [],
      contact: {
        name: document.getElementById('company-event-contact').value,
        role: document.getElementById('company-event-contact-role').value,
        linkedin: document.getElementById('company-event-contact-link').value,
      },
      text: document.getElementById('company-event-text').value,
    };
    let result;
    try {
      result = await this.api('/api/company/communication', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: state.id, communication }),
      });
    } catch (error) {
      return alert(`Could not save company update: ${error.message}`);
    }
    if (!result?.ok) return alert(`Could not save company update: ${result?.error || 'unknown error'}`);
    state.data = result;
    this.renderCompanyHistory();
  },

  async removeCompanyCommunication(communicationId) {
    const state = this.companyHistory;
    if (!state || !confirm('Remove this manually recorded company update?')) return;
    let result;
    try {
      result = await this.api('/api/company/communication/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: state.id, communicationId }),
      });
    } catch (error) {
      return alert(`Could not remove company update: ${error.message}`);
    }
    if (!result?.ok) return alert(`Could not remove company update: ${result?.error || 'unknown error'}`);
    state.data = result;
    this.renderCompanyHistory();
  },

  openCompanyRoleChat(id) {
    this.closeCompanyHistory();
    this.openChat(id, 'ask');
  },

  waitFor(selector) {
    return new Promise((resolve) => {
      const tick = () => (document.querySelector(selector) ? resolve() : setTimeout(tick, 50));
      tick();
    });
  },

  async seeCv(slug, opportunityId = null) {
    this.showTab('cv');
    await this.waitFor('#cv-text');
    this.openCv(`applications/${slug}/cv.typ`, slug, opportunityId);
  },

  async seeCoverLetter(slug) {
    this.showTab('cv');
    await this.waitFor('#cv-text');
    this.openCv(`applications/${slug}/outreach.md`, null);
  },

  chooseCvOptions(id, artifactSlug = null) {
    this.cvOptionsOpportunityId = id;
    this.cvOptionsArtifactSlug = artifactSlug || null;
    document.getElementById('cv-option-xyz').checked = true;
    document.getElementById('cv-option-humanize').checked = true;
    document.getElementById('cv-options-overlay').classList.remove('hidden');
  },

  closeCvOptions() {
    this.cvOptionsOpportunityId = null;
    this.cvOptionsArtifactSlug = null;
    document.getElementById('cv-options-overlay').classList.add('hidden');
  },

  startCvFromOptions() {
    const id = this.cvOptionsOpportunityId;
    if (!id) return this.closeCvOptions();
    const cvOptions = {
      xyz: document.getElementById('cv-option-xyz').checked,
      humanize: document.getElementById('cv-option-humanize').checked,
    };
    const artifactSlug = this.cvOptionsArtifactSlug;
    this.closeCvOptions();
    this.openChat(id, 'cv', cvOptions, 'job', artifactSlug);
  },

  async renderCv() {
    const list = await this.api('/api/cv');
    this.state.cvFiles = list;
    const el = document.getElementById('tab-cv');
    const entries = list.entries || (list.applications || []).map((slug) => ({ slug, source: true }));
    const appBtns = entries.map((entry) => {
      const cvPath = `applications/${entry.slug}/cv.typ`;
      const matches = this.opportunitiesForSlug(entry.slug);
      const opportunityId = matches.length === 1 ? matches[0].id : null;
      const label = matches.length === 1
        ? `${matches[0].company} — ${matches[0].role}`
        : matches.length > 1 ? `${matches[0].company} — ${matches.length} tracked roles (shared folder — created before per-role CVs)` : entry.slug;
      const pdfState = entry.restored ? 'Needs re-rendering after restore' : entry.pdfCurrent ? 'PDF ready' : entry.pdfStale ? 'PDF stale' : 'PDF missing';
      const states = [pdfState, entry.quality ? 'quality recorded' : 'legacy', matches.length ? null : 'unmatched']
        .filter(Boolean).map((value) => `<span class="chip">${this.esc(value)}</span>`).join('');
      return `<button class="act cv-entry" data-action="open-cv" data-cv-path="${this.esc(cvPath)}" data-slug="${this.esc(entry.slug)}" data-opportunity-id="${this.esc(opportunityId || '')}"><span class="cv-entry-label">${this.esc(label)}</span><span class="cv-entry-state">${states}</span></button>`;
    }).join('') || '<div class="meta">No tailored CVs yet. Create one from a tracked opportunity.</div>';
    const opportunities = (this.state.data?.opportunities || [])
      .filter((entry) => !['rejected', 'accepted'].includes(entry.status))
      .sort((a, b) => `${a.company} ${a.role}`.localeCompare(`${b.company} ${b.role}`));
    const opportunityOptions = opportunities.map((entry) =>
      `<option value="${this.esc(entry.id)}">${this.esc(entry.company)} — ${this.esc(entry.role)}</option>`).join('');
    el.innerHTML = `
      <div class="cv-library-head"><div><h2>CV library</h2><div class="meta">Existing sources remain available even before a PDF or quality review exists.</div></div><button class="act bridge" data-action="toggle-cv-create">Review CV options</button></div>
      <div id="cv-create-panel" class="cv-create-panel hidden cv-create">
        ${opportunityOptions ? `<label>Tracked opportunity<select id="cv-create-opportunity">${opportunityOptions}</select></label><button class="act primary" data-action="start-cv-create">Start tailored CV</button>` : '<div class="meta">Add a tracked opportunity before creating a tailored CV.</div>'}
      </div>
      <div class="cv-layout">
        <aside class="cv-sidebar">
          <div class="label">master</div>
          <button class="act" data-action="open-cv" data-cv-path="${this.esc('cv/master-cv.md')}">master-cv.md</button>
          <div class="label">applications</div>${appBtns}
        </aside>
        <section class="cv-editor-panel">
          <div class="label"><span id="cv-editing">select a file</span> <span id="cv-dirty" style="color:var(--warn)"></span> <span id="cv-status" class="meta"></span></div>
          <textarea id="cv-text" class="cv-source" data-input-action="cv-dirty"></textarea>
           <div class="controls" style="flex-wrap:wrap;margin-top:6px">
             <button id="cv-save" class="act" data-action="save-cv">save changes</button>
             <button id="cv-render" class="act" data-action="render-cv">render PDF</button>
             <button id="cv-download" class="act" data-action="download-cv" disabled>download PDF</button>
           </div>
           <div id="cv-quality" class="cv-quality"><div class="meta">Select a tailored CV to see its quality review.</div></div>
          <div class="cv-chat-request">
            <div class="label">request changes through the job chat</div>
            <div class="meta">This opens the same job-specific Codex or Claude conversation used to create the CV. Your request is placed in the message box for review; nothing is sent until you press Send in the chat drawer.</div>
            <div class="cv-chat-request-row">
              <input id="cv-instruction" class="act" placeholder="e.g. lead with the drone/UAV angle and mention the composites oven rig">
              <button class="act bridge" data-action="open-chat-for-cv">open job chat with request</button>
            </div>
          </div>
        </section>
        <section class="cv-preview-panel">
          <div class="cv-preview-toolbar">
            <div class="label" style="margin:0">PDF preview</div>
            <label class="meta">scale
              <select id="cv-preview-zoom" class="act" data-change-action="cv-zoom">
                <option value="page-width" selected>fit width</option>
                <option value="page-fit">fit page</option>
                <option value="100">100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
              </select>
            </label>
            <button id="cv-fullscreen" class="act" data-action="fullscreen-cv" disabled>full screen</button>
            <button id="cv-open-pdf" class="act" data-action="open-cv-pdf" disabled>open PDF</button>
          </div>
          <div id="cv-preview-shell">
            <div id="cv-preview">Select a tailored CV to render its PDF.</div>
          </div>
        </section>
      </div>`;
    if (this.cvState.path && typeof this.cvState.content === 'string') {
      document.getElementById('cv-text').value = this.cvState.content;
      document.getElementById('cv-editing').textContent = `editing: ${this.cvState.path}`;
      document.getElementById('cv-dirty').textContent = this.cvState.dirty ? 'unsaved' : '';
      document.querySelectorAll('[data-cv-path]').forEach((button) => button.classList.toggle('active', button.dataset.cvPath === this.cvState.path));
      this.updateCvControls();
      await this.showStoredCv();
      await this.reattachCvRender();
    }
  },

  opportunityIdForSlug(slug) {
    const matches = this.opportunitiesForSlug(slug);
    return matches.length === 1 ? matches[0].id : null;
  },

  opportunitiesForSlug(slug) {
    return (this.state.data?.opportunities || []).filter((entry) =>
      this.artifactSlugFor(entry) === slug || this.slugOf(entry.company) === slug);
  },

  toggleCvCreate() {
    document.getElementById('cv-create-panel')?.classList.toggle('hidden');
  },

  startCvCreate() {
    const id = document.getElementById('cv-create-opportunity')?.value;
    if (!id) return;
    return this.reviewCvOptions(id);
  },

  // The single place that resolves an opportunity's CV folder and, where an
  // existing folder could be reused, asks the user. Every entry point (the CV
  // library picker and the Shortlist card) routes through here, so no path can
  // reach generation without the collision prompt. The answer is carried into
  // generation as the artifact slug, so "start fresh" really does write to a new
  // per-role folder and the existing folder is never overwritten.
  reviewCvOptions(id) {
    const entry = (this.state.data?.opportunities || []).find((item) => item.id === id);
    if (!entry) return;
    const resolved = this.resolveArtifactFor(entry);
    const exists = (this.state.cvFiles?.applications || []).includes(resolved.slug);
    // Not legacy, or legacy but the only tracked role at that employer: the folder
    // can only be this role's own CV, so open it without a confusing prompt.
    if (exists && (!resolved.legacy || !resolved.ambiguous)) return this.seeCv(resolved.slug, id);
    if (exists) {
      if (!confirm('Scout has an existing CV folder shared with another role at this company, created before per-role CV folders. Open it as-is? Choose Cancel to start a new CV in its own folder for this role - the existing folder is left untouched.')) {
        return this.chooseCvOptions(id, this.artifactSlugFor(entry));
      }
      return this.seeCv(resolved.slug, id);
    }
    this.chooseCvOptions(id, resolved.slug);
  },

  async refreshCvFilesIfTouched(filesTouched = []) {
    if (!(filesTouched || []).some((file) => /^applications\/[^/]+\/(?:cv\.typ|cv\.pdf|cv-quality\.json)$/.test(String(file)))) return;
    try {
      this.state.cvFiles = await this.api('/api/cv');
      this.renderAll();
      if (this.state.tab === 'cv') await this.renderCv();
    } catch { /* a refresh failure must not hide a completed chat turn */ }
  },

  async openCv(pathRel, slug, opportunityId = null) {
    if (this.cvState.dirty && !confirm('Discard unsaved changes?')) return;
    const text = await this.api(`/api/cv/file?path=${encodeURIComponent(pathRel)}`);
    const content = typeof text === 'string' ? text : (text.error || '');
    this.cvState = { path: pathRel, slug, opportunityId, content, dirty: false };
    document.getElementById('cv-text').value = content;
    document.getElementById('cv-editing').textContent = `editing: ${pathRel}`;
    document.getElementById('cv-dirty').textContent = '';
    this.setCvStatus(''); // a save/render status belongs to the file it came from
    document.querySelectorAll('[data-cv-path]').forEach((b) =>
      b.classList.toggle('active', b.dataset.cvPath === pathRel));
    this.updateCvControls();
    await this.showStoredCv();
    if (slug) await this.refreshCvQuality(slug);
    else {
      const quality = document.getElementById('cv-quality');
      if (quality) quality.innerHTML = '<div class="label">Master reference</div><b>Evidence source</b><div class="meta">The reference PDF is for reviewing the approved master evidence. Tailored application PDFs keep their separate quality gate.</div>';
    }
  },

  currentCvRequest() {
    if (!this.cvState.path) return null;
    return this.cvState.slug ? { target: 'application', slug: this.cvState.slug } : { target: 'master' };
  },

  currentCvRenderState() {
    if (!this.cvState.path) return { pdf: false, current: false, stale: false };
    if (!this.cvState.slug) return this.state.cvFiles?.masterRender || { pdf: false, current: false, stale: false };
    const entry = this.state.cvFiles?.entries?.find((item) => item.slug === this.cvState.slug);
    if (!entry) return { pdf: false, current: false, stale: false };
    return { ...entry, current: entry.pdfCurrent === true, stale: entry.pdfStale === true };
  },

  updateCvControls() {
    const current = this.currentCvRenderState().current === true;
    for (const id of ['cv-download', 'cv-fullscreen', 'cv-open-pdf']) {
      const button = document.getElementById(id); if (button) button.disabled = !current;
    }
  },

  async showStoredCv() {
    const preview = document.getElementById('cv-preview');
    if (!preview || !this.cvState.path) return;
    const state = this.currentCvRenderState();
    if (state.current) this.showPdf();
    else preview.innerHTML = `<div class="cv-preview-status">${state.stale ? 'This PDF is stale because the source changed. Save and render again.' : this.cvState.slug ? 'No tailored PDF yet. Save and render to create it.' : 'No master reference PDF yet. Save and render to create it.'}</div>`;
  },

  setCvStatus(text) {
    const status = document.getElementById('cv-status');
    if (status) status.textContent = text;
  },

  async saveCv() {
    if (!this.cvState.path) return alert('Open a file first.');
    const content = document.getElementById('cv-text').value;
    this.setCvStatus('Saving…');
    const save = await this.post('/api/cv/save', { path: this.cvState.path, content });
    if (!(save && save.ok)) return this.setCvStatus('Save failed. Your changes are still in the editor.');
    this.cvState.dirty = false;
    this.cvState.content = content;
    const dirty = document.getElementById('cv-dirty');
    if (dirty) dirty.textContent = '';
    this.setCvStatus('Saved. The PDF is out of date until you render it.');
  },

  async renderCvOnly() {
    if (!this.cvState.path) return alert('Open a file first.');
    if (this.cvState.dirty) return this.setCvStatus('Save your changes first — rendering uses the last saved source.');
    this.setCvStatus('Rendering PDF…');
    try {
      await this.renderCvPreview();
      this.setCvStatus('PDF rendered from the saved source.');
    } catch (error) {
      this.setCvStatus(`Saved source is intact. PDF render failed: ${error?.message || String(error)}`);
    }
  },

  async renderCvPreview() {
    const preview = document.getElementById('cv-preview');
    const request = this.currentCvRequest();
    if (!preview || !request) return;
    preview.innerHTML = '<div class="cv-preview-status">rendering PDF...</div>';
    try {
      const response = await fetch('/api/cv/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Render could not start (${response.status})`);
      await this.watchCvRender(body.operation.id);
    } catch (e) {
      preview.innerHTML = `<div class="cv-preview-error">Preview could not load: ${this.esc(e.message)}</div>`;
      throw e;
    }
  },

  async watchCvRender(id) {
    if (!id) return;
    if (this.cvRenderTimer) clearTimeout(this.cvRenderTimer);
    const poll = async (resolve) => {
      const preview = document.getElementById('cv-preview');
      try {
        const response = await fetch(`/api/operations/${encodeURIComponent(id)}`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'PDF render status unavailable');
        const operation = body.operation;
        if (preview && ['queued', 'running'].includes(operation.status)) preview.innerHTML = `<div class="cv-preview-status">${this.esc(operation.phase || 'Rendering PDF')} · step ${this.esc(operation.progress?.current || 0)}/${this.esc(operation.progress?.total || 3)}</div>`;
        if (['queued', 'running'].includes(operation.status)) {
          this.cvRenderTimer = setTimeout(() => poll(resolve), 250);
          return;
        }
        this.cvRenderTimer = null;
        if (operation.status === 'failed') {
          if (preview) preview.innerHTML = `<div class="cv-preview-error">Render failed: ${this.esc(operation.error || 'unknown error')}</div>`;
        } else {
          this.state.cvFiles = await this.api('/api/cv');
          this.updateCvControls();
          await this.showStoredCv();
          if (this.cvState.slug) await this.refreshCvQuality(this.cvState.slug);
        }
      } catch (error) {
        this.cvRenderTimer = null;
        if (preview) preview.innerHTML = `<div class="cv-preview-error">Render status unavailable: ${this.esc(error.message)}</div>`;
      }
      resolve?.();
    };
    return new Promise((resolve) => poll(resolve));
  },

  async reattachCvRender() {
    try {
      const body = await this.api('/api/operations?type=cv-render');
      if (body.operation && ['queued', 'running'].includes(body.operation.status)) this.watchCvRender(body.operation.id);
    } catch { /* no active render */ }
  },

  async refreshCvQuality(slug) {
    const panel = document.getElementById('cv-quality');
    if (!panel || !slug) return;
    let quality;
    try { quality = await this.api(`/api/cv/quality?slug=${encodeURIComponent(slug)}`); }
    catch (e) { quality = { status: 'invalid', error: e.message }; }
    if (quality.error) {
      panel.className = 'cv-quality invalid';
      panel.innerHTML = `<b>Quality review unavailable</b><div class="meta">${this.esc(quality.error)}</div>`;
      return;
    }
    const status = quality.status || (quality.pass ? 'ready' : 'draft');
    const issues = [...(quality.blocking || []), ...(quality.warnings || [])];
    const optionText = quality.options
      ? `XYZ ${quality.options.xyz ? 'on' : 'off'} · natural voice ${quality.options.humanize ? 'on' : 'off'}`
      : 'Legacy CV · review options were not recorded';
    panel.className = `cv-quality ${this.esc(status)}`;
    panel.innerHTML = `<div class="label">CV quality</div><b>${this.esc(status === 'ready' ? 'Ready' : status === 'overridden' ? 'Draft accepted' : 'Draft')}</b>
      <div class="meta">${this.esc(optionText)}</div>
      ${issues.length ? `<ul>${issues.map((entry) => `<li>${this.esc(entry.message)}</li>`).join('')}</ul>` : '<div class="meta">All enabled checks passed.</div>'}
      <div class="controls" style="flex-wrap:wrap;margin-top:8px">
        <button class="act" data-action="run-cv-quality-review">run quality review</button>
        ${this.cvState.opportunityId ? '<button class="act bridge" data-action="review-evidence-for-master">review answers for master CV</button>' : ''}
      </div>`;
    this.cvState.quality = quality;
  },

  async runCvQualityReview() {
    if (!this.cvState.slug) return alert('Open a tailored CV first.');
    const result = await this.api('/api/cv/quality', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: this.cvState.slug }),
    });
    if (result.error) alert(`Quality review failed: ${result.error}`);
    await this.refreshCvQuality(this.cvState.slug);
  },

  reviewEvidenceForMaster() {
    if (!this.cvState.opportunityId) return alert('Open this CV from its opportunity card first.');
    this.openChat(this.cvState.opportunityId, 'reuseEvidence', null, 'job', this.cvState.slug || null);
  },

  pdfUrl({ download = false } = {}) {
    const request = this.currentCvRequest();
    if (!request) return '';
    const query = request.target === 'master' ? 'target=master' : `slug=${encodeURIComponent(request.slug)}`;
    return `/api/cv/pdf?${query}${download ? '&download=1' : ''}&t=${Date.now()}#zoom=${encodeURIComponent(this.cvPreviewZoom)}`;
  },

  showPdf() {
    const url = this.pdfUrl();
    document.getElementById('cv-preview').innerHTML =
      `<iframe class="cv-preview-frame" title="CV PDF preview" src="${url}"></iframe>`;
  },

  setCvZoom(zoom) {
    this.cvPreviewZoom = zoom;
    if (this.currentCvRenderState().current) this.showPdf();
  },

  async fullscreenCv() {
    const shell = document.getElementById('cv-preview-shell');
    if (!shell) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch (e) {
      alert(`Full screen is unavailable: ${e.message}`);
    }
  },

  openCvPdf() {
    if (!this.currentCvRenderState().current) return alert('Save and render a current PDF first.');
    window.open(this.pdfUrl(), '_blank', 'noopener');
  },

  async downloadCv() {
    if (!this.currentCvRenderState().current) return alert('Save and render a current PDF first.');
    if (!this.cvState.slug) {
      const a = document.createElement('a');
      a.href = this.pdfUrl({ download: true }); a.download = 'master-cv-reference.pdf';
      document.body.appendChild(a); a.click(); a.remove(); return;
    }
    let quality = await this.api(`/api/cv/quality?slug=${encodeURIComponent(this.cvState.slug)}`);
    if (quality.error) return alert(`Could not check CV quality: ${quality.error}`);
    if (!['ready', 'overridden'].includes(quality.status)) {
      if ((quality.blocking || []).length) return alert(`This CV cannot be downloaded yet:\n\n${quality.blocking.map((entry) => entry.message).join('\n')}`);
      if (!confirm('This CV is still labelled Draft. Use this draft anyway?')) return;
      const cvSha256 = quality.currentCvSha256 || quality.cvSha256;
      quality = await this.api('/api/cv/quality/override', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: this.cvState.slug, cvSha256 }),
      });
      if (quality.error) return alert(`Could not accept this draft: ${quality.error}`);
      await this.refreshCvQuality(this.cvState.slug);
    }
    const a = document.createElement('a');
    a.href = this.pdfUrl({ download: true });
    a.download = `${this.cvState.slug}-cv.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  // --- Embedded chat drawer ---

  async openChat(id, prefillKey = 'ask', cvOptions = null, purpose = 'job', artifactSlug = null) {
    this.closeCompanyHistory();
    const previous = this.chat;
    if (previous && previous.streaming) {
      if (previous.id === id && previous.purpose === purpose) {
        document.getElementById('chat-drawer').classList.remove('hidden');
        return;
      }
      if (!confirm('Another job has a turn running - stop it and switch chats?')) return;
      if (!await this.stopChat(previous)) return;
    }
    if (previous?.pollTimer) clearTimeout(previous.pollTimer);
    const openSeq = ++this.chatOpenSeq;
    if (this.chatDrawerState && this.chatDrawerState.chatId !== null) {
      this.chatDrawerState = reduceChatDrawer(this.chatDrawerState, {
        type: 'chat/closed',
        chatId: this.chatDrawerState.chatId,
        generation: this.chatDrawerState.generation,
      });
    }
    let r;
    const optionQuery = cvOptions
      ? `&xyz=${cvOptions.xyz ? '1' : '0'}&humanize=${cvOptions.humanize ? '1' : '0'}`
      : '';
    const purposeQuery = purpose === 'job' ? '' : `&purpose=${encodeURIComponent(purpose)}`;
    // The user's answer to the existing-folder prompt (and the folder an already
    // open CV lives in). The server re-resolves and only honours a slug it would
    // produce for this opportunity itself.
    const artifactQuery = artifactSlug ? `&artifact=${encodeURIComponent(artifactSlug)}` : '';
    try { r = await this.api(`/api/chat?id=${encodeURIComponent(id)}${purposeQuery}${optionQuery}${artifactQuery}`); }
    catch (e) {
      if (openSeq === this.chatOpenSeq) alert(`Could not open chat: ${e.message}`);
      return;
    }
    if (openSeq !== this.chatOpenSeq) return;
    if (r && r.error) return alert(r.error);
    const c = {
      id,
      data: r.chat || { engine: null, cliSessionId: null, messages: [], filesTouched: [] },
      engine: r.chat ? r.chat.engine : null,
      model: r.chat ? (r.chat.model || null) : null,
      prefills: r.prefills || {},
      purpose: r.purpose || purpose,
      artifact: r.artifact || null,
      streaming: !!r.busy,
      recovering: !!r.busy,
      pollTimer: null,
      mode: prefillKey === 'fit' ? 'fit-assessment' : null,
    };
    this.chat = c;
    this.enginePicks = {};
    this.engineOptions = null;
    this.chatDrawerState = createChatDrawerState(id, openSeq);
    this.renderChatDrawer();
    let prefill = c.prefills[prefillKey] || '';
    if (prefillKey === 'tweak') {
      const instr = (document.getElementById('cv-instruction')?.value || '').trim();
      if (instr) prefill = prefill.replace('<your change>', instr);
    }
    document.getElementById('chat-input').value = prefill;
    void this.loadEngineOptions(c);
    void this.refreshUsage(c);
    void this.refreshCodexDeepLink(c);
    if (c.recovering) this.scheduleChatRecovery(c);
  },

  openInterviewPrep(id) {
    this.openChat(id, 'interviewPrep', null, 'interview-prep');
  },

  interviewPrepRecommended(id) {
    return (this.state.data?.pipeline?.active || [])
      .some((item) => item.id === id && item.needsInterviewPrep);
  },

  scheduleChatRecovery(c) {
    if (this.chat !== c || !c.recovering) return;
    if (c.pollTimer) clearTimeout(c.pollTimer);
    c.pollTimer = setTimeout(() => this.pollBusyChat(c), 1000);
  },

  async pollBusyChat(c) {
    if (this.chat !== c || !c.recovering) return;
    c.pollTimer = null;
    let r;
    const purposeQuery = c.purpose === 'job' ? '' : `&purpose=${encodeURIComponent(c.purpose)}`;
    try { r = await this.api(`/api/chat?id=${encodeURIComponent(c.id)}${purposeQuery}`); }
    catch {
      this.scheduleChatRecovery(c);
      return;
    }
    if (this.chat !== c || !c.recovering) return;
    if (!r || r.error || r.busy) {
      this.scheduleChatRecovery(c);
      return;
    }
    const draft = document.getElementById('chat-input')?.value || '';
    const following = this.chatNearBottom(document.getElementById('chat-body'));
    const previousScrollTop = document.getElementById('chat-body')?.scrollTop || 0;
    c.data = r.chat || c.data;
    c.engine = r.chat ? r.chat.engine : c.engine;
    c.prefills = r.prefills || c.prefills;
    c.artifact = r.artifact || c.artifact;
    c.streaming = false;
    c.recovering = false;
    this.renderChatDrawer();
    const input = document.getElementById('chat-input');
    if (input) input.value = draft;
    if (!following) document.getElementById('chat-body').scrollTop = previousScrollTop;
    this.refreshUsage(c);
    void this.refreshCodexDeepLink(c);
  },

  renderChatDrawer() {
    const d = document.getElementById('chat-drawer');
    const c = this.chat;
    if (!c) return d.classList.add('hidden');
    d.classList.remove('hidden');
    const picker = this.chatPickerHtml();
    const usageSlot = this.chatDrawerState?.usage;
    const usageView = usageSlot?.status === 'ready'
      ? this.usageSummaryView(usageSlot.value)
      : usageSlot?.status === 'error'
        ? this.usageSummaryView(null)
        : { text: 'Checking AI usage…', title: 'Provider usage is loading' };
    const prep = c.purpose === 'interview-prep';
    const chatModelStatus = this.chatModelStatusHtml(c);
    const codexTaskControls = this.codexTaskControlsHtml(c);
    const prepControls = prep ? `<div class="controls" style="padding:8px 12px;flex-wrap:wrap">
      <button class="act bridge" data-action="use-prep-prompt" data-prompt="interviewPrep">generate pack</button>
      <button class="act" data-action="use-prep-prompt" data-prompt="prepRefresh">refresh research</button>
      <button class="act" data-action="use-prep-prompt" data-prompt="prepQuestions">practise questions</button>
      <button class="act" data-action="use-prep-prompt" data-prompt="prepMock">mock interview</button>
    </div>` : '';
    d.innerHTML = `
      <div class="chat-head">
        <b>${prep ? 'Interview prep - ' : ''}${this.esc(this.company(c.id))}</b>
        ${c.engine ? `<span class="chip" style="margin-left:0">${this.esc(c.engine)}</span>` : ''}
        ${c.engine ? `<span class="chip model-chip" title="Model used for this conversation">${this.esc(c.model || 'provider default')}</span>` : ''}
        ${chatModelStatus}
        <span id="usage-meters" class="meta" role="status" aria-live="polite" title="${this.esc(usageView.title)}">${this.esc(usageView.text)}</span>
        ${c.engine && c.data.cliSessionId
          ? '<button class="act" data-action="handoff-chat">summarise &amp; switch</button>'
          : ''}
        ${codexTaskControls}
        <button class="act" style="margin-left:auto" data-action="close-chat">close</button>
      </div>
      <div class="chat-companion">${scoutMarkup(c.streaming ? 'thinking' : 'listening')}<div class="scout-bubble tail-left"><span id="scout-chat-status">${c.streaming ? 'I’m thinking…' : prep ? 'Build your prep pack, refresh research, or practise here.' : 'Ask me anything about this opportunity.'}</span></div></div>
      ${prepControls}
      <div id="chat-body" class="chat-body">${c.engine ? '' : picker}</div>
      <div class="chat-foot" ${c.engine ? '' : 'style="display:none"'}>
        <textarea id="chat-input" placeholder="message ${this.esc(c.engine || '')} - Enter sends, Shift+Enter for a new line" data-keydown-action="chat-key"></textarea>
        <button class="act" id="chat-send" data-action="send-chat">send</button>
        <button class="act" id="chat-stop" style="display:none" data-action="stop-chat">stop</button>
      </div>`;
    this.renderChatMessages();
    this.setChatBusy(c.streaming);
    applyScoutState(d.querySelector('.scout-character'), c.streaming ? 'thinking' : 'listening', { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    this.initScoutSprites(d);
  },

  initScoutSprites(container = document) {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.querySelectorAll('.scout-character').forEach((element) => {
      applyScoutState(element, element.dataset.scoutState || 'idle', { reducedMotion });
    });
  },

  // Provider allowances are account-wide, so headroom is reported per engine.
  // Claude's logs additionally record which model produced each turn, which gives
  // spend per model but no per-model ceiling — it is labelled as spend, never as
  // anything remaining.
  engineUsageHtml(engine, usage) {
    if (!usage || usage.unknown) return '<span class="engine-usage unknown">usage unavailable</span>';
    if (engine === 'codex') {
      const windows = usage.windows?.length ? usage.windows : [usage.primary, usage.secondary].filter(Boolean);
      if (!windows.length) return '<span class="engine-usage unknown">usage unavailable</span>';
      return windows.map((window) => {
        const reset = window.resetsAt ? ` · resets ${this.esc(new Date(window.resetsAt).toLocaleString())}` : '';
        return `<span class="engine-usage"><b>${this.esc(Math.round(window.usedPercent))}%</b> of your ${this.esc(window.label)} limit used${reset}</span>`;
      }).join('');
    }
    const thousands = (value) => `${Math.round(Number(value || 0) / 1000).toLocaleString()}k`;
    return `<span class="engine-usage">~${this.esc(thousands(usage.fiveHourTokens))} tokens in the last 5 hours · ~${this.esc(thousands(usage.weekTokens))} this week</span>
      <span class="engine-usage note">account-wide; Claude does not publish a per-model limit</span>`;
  },

  modelSpendHtml(engine, usage, modelId) {
    if (engine !== 'claude' || !modelId) return '';
    const entry = (usage?.byModel || []).find((item) => item.model === modelId);
    if (!entry) return '';
    const thousands = (value) => `${Math.round(Number(value || 0) / 1000).toLocaleString()}k`;
    return `<span class="engine-usage note">~${this.esc(thousands(entry.weekTokens))} tokens spent on this model this week</span>`;
  },

  usageSummaryView(usage) {
    const bits = [];
    const titles = [];
    if (usage?.claude && !usage.claude.unknown) {
      bits.push(`claude estimated account usage ~${Math.round(Number(usage.claude.fiveHourTokens || 0) / 1000)}k/5h ~${Math.round(Number(usage.claude.weekTokens || 0) / 1000)}k/week`);
    } else {
      bits.push('claude usage unavailable');
    }
    const windows = usage?.codex?.windows?.length
      ? usage.codex.windows
      : [usage?.codex?.primary, usage?.codex?.secondary].filter(Boolean);
    if (windows.length) {
      bits.push(`codex ${windows.map((window) => `${Math.round(Number(window.usedPercent || 0))}% ${window.label} allowance used`).join(', ')}`);
      for (const window of windows) {
        if (window.resetsAt) titles.push(`codex ${window.label} resets ${new Date(window.resetsAt).toLocaleString()}`);
      }
    } else {
      bits.push('codex usage unavailable');
    }
    if (usage?.checkedAt) titles.push(`checked ${new Date(usage.checkedAt).toLocaleTimeString()}`);
    return {
      text: bits.join(' · '),
      title: ['Usage sources remain semantically distinct', ...titles].join(' · '),
    };
  },

  engineCardHtml(engine, info) {
    const name = engine[0].toUpperCase() + engine.slice(1);
    const models = info?.models || [];
    const selected = this.enginePicks?.[engine] ?? '';
    const effective = info?.effectiveModel || {
      id: info?.defaultModel || null,
      label: info?.defaultModel || 'Provider default (model unknown)',
      known: Boolean(info?.defaultModel),
      available: 'unknown',
    };
    const defaultUnavailable = effective.available === false;
    const defaultLabel = defaultUnavailable
      ? `Provider default unavailable — ${effective.label}`
      : effective.known ? `Provider default — ${effective.label}` : 'Provider default — model unknown';
    const option = (value, label, { disabled = false } = {}) =>
      `<option value="${this.esc(value)}" ${disabled ? 'disabled' : ''} ${String(selected) === String(value) ? 'selected' : ''}>${this.esc(label)}</option>`;
    const catalogueLabel = info?.catalogue?.state === 'refreshed'
      ? 'refreshed catalogue'
      : 'bundled fallback · availability may be unknown';
    const modelLabel = (model) => [
      model.label,
      model.tradeoff,
      model.available === false ? 'unavailable' : model.available === 'unknown' ? 'availability unknown' : '',
    ].filter(Boolean).join(' — ');
    const unavailableExplanation = defaultUnavailable
      ? `<div class="engine-model-warning" role="status">Saved default unavailable. Choose another model before starting this chat.</div>`
      : '';
    return `<div class="engine-card" data-engine-card="${this.esc(engine)}">
      <div class="engine-head"><b>${this.esc(name)}</b><span class="chip">${this.esc(catalogueLabel)}</span></div>
      <div class="engine-usage-block">${this.engineUsageHtml(engine, info?.usage)}</div>
      <label class="engine-model">Model
        <select data-engine-model="${this.esc(engine)}">
          ${option('', defaultLabel, { disabled: defaultUnavailable })}
          ${models.map((model) => option(model.id, modelLabel(model), { disabled: model.available === false })).join('')}
          ${option('__other__', 'Other…')}
        </select>
      </label>
      <input class="engine-model-custom ${selected === '__other__' ? '' : 'hidden'}" data-engine-model-custom="${this.esc(engine)}" type="text" placeholder="Exact model id" maxlength="128" pattern="[A-Za-z0-9._:\-]{1,128}">
      <div class="engine-model-spend">${this.modelSpendHtml(engine, info?.usage, selected)}</div>
      ${unavailableExplanation}
      <div class="engine-model-status meta" role="status" aria-live="polite"></div>
      <button class="act primary" data-action="pick-engine" data-engine="${this.esc(engine)}">Use ${this.esc(name)}</button>
    </div>`;
  },

  chatPickerHtml() {
    const onboarding = this.chat?.id === 'setup-onboarding';
    const prep = this.chat?.purpose === 'interview-prep';
    const engineSlot = this.chatDrawerState?.engines;
    const engines = engineSlot?.value?.engines;
    return `<div class="chat-picker">
      <div class="label">choose an engine and model for ${onboarding ? 'setup' : prep ? 'interview prep' : 'this job'}</div>
      <div class="engine-cards">
        ${['claude', 'codex'].map((engine) => this.engineCardHtml(engine, engines?.[engine])).join('')}
      </div>
      ${engines ? '' : engineSlot?.status === 'error'
        ? '<p class="meta" role="status">Model choices unavailable. Provider defaults and safe custom IDs remain available.</p>'
        : '<p class="meta" role="status">Checking model choices…</p>'}
    </div>`;
  },

  renderChatDrawerSnapshot() {
    const draft = document.getElementById('chat-input')?.value;
    const body = document.getElementById('chat-body');
    const following = this.chatNearBottom(body);
    const scrollTop = body?.scrollTop;
    const customInputs = typeof document.querySelectorAll === 'function'
      ? [...document.querySelectorAll('[data-engine-model-custom]')]
      : [];
    const customs = Object.fromEntries(customInputs
      .map((input) => [input.dataset.engineModelCustom, input.value]));
    this.renderChatDrawer();
    const input = document.getElementById('chat-input');
    if (input && draft !== undefined) input.value = draft;
    for (const [engine, value] of Object.entries(customs)) {
      const custom = document.querySelector(`[data-engine-model-custom="${engine}"]`);
      if (custom) custom.value = value;
    }
    if (!following && scrollTop !== undefined) {
      const nextBody = document.getElementById('chat-body');
      if (nextBody) nextBody.scrollTop = scrollTop;
    }
  },

  async loadEngineOptions(target = this.chat) {
    const drawer = this.chatDrawerState;
    if (!target || !drawer || drawer.chatId !== target.id) return;
    const requestGeneration = drawer.engines.requestGeneration + 1;
    this.chatDrawerState = reduceChatDrawer(drawer, {
      type: 'engines/requested',
      chatId: drawer.chatId,
      generation: drawer.generation,
      requestGeneration,
    });
    let value;
    try {
      value = await this.api('/api/engines');
      if (!value?.engines) throw new Error('model choices unavailable');
    } catch {
      const before = this.chatDrawerState;
      this.chatDrawerState = reduceChatDrawer(before, {
        type: 'engines/rejected',
        chatId: drawer.chatId,
        generation: drawer.generation,
        requestGeneration,
        error: 'model choices unavailable',
      });
      if (this.chatDrawerState !== before) this.renderChatDrawerSnapshot();
      return;
    }
    const before = this.chatDrawerState;
    this.chatDrawerState = reduceChatDrawer(before, {
      type: 'engines/resolved',
      chatId: drawer.chatId,
      generation: drawer.generation,
      requestGeneration,
      value,
    });
    if (this.chatDrawerState !== before) {
      this.engineOptions = value;
      this.renderChatDrawerSnapshot();
    }
  },

  // Keep the remembered pick, the free-text field and the per-model spend line in
  // step with the dropdown.
  onEngineModelChange(select) {
    const engine = select.dataset.engineModel;
    const card = select.closest('[data-engine-card]');
    if (!card) return;
    this.enginePicks = { ...this.enginePicks, [engine]: select.value };
    card.querySelector('[data-engine-model-custom]')?.classList.toggle('hidden', select.value !== '__other__');
    const status = card.querySelector('.engine-model-status');
    if (status) status.textContent = '';
    const spend = card.querySelector('.engine-model-spend');
    const info = this.chatDrawerState?.engines?.value?.engines?.[engine];
    if (spend) spend.innerHTML = this.modelSpendHtml(engine, info?.usage, select.value);
  },

  selectedEngineModel(engine) {
    const card = document.querySelector(`[data-engine-card="${engine}"]`);
    if (!card) return null;
    const value = card.querySelector('[data-engine-model]')?.value || '';
    if (value !== '__other__') return value || null;
    return card.querySelector('[data-engine-model-custom]')?.value.trim() || null;
  },

  chatModelStatusHtml(chat = this.chat) {
    if (!chat?.engine) return '';
    const info = this.chatDrawerState?.engines?.value?.engines?.[chat.engine];
    if (!info) return '';
    const record = chat.model
      ? (info.models || []).find((model) => model.id === chat.model)
      : info.effectiveModel;
    if (record?.available !== false) return '';
    const label = record.label || record.id || chat.model || 'saved provider default';
    const subject = chat.model ? 'Conversation model' : 'Saved default';
    return `<span class="chat-model-status meta" role="status" aria-live="polite">
      ${this.esc(subject)} ${this.esc(label)} is unavailable. Choose a currently available model if a new turn fails.
    </span>`;
  },

  codexTaskControlsHtml(chat = this.chat) {
    const taskId = chat?.engine === 'codex' ? chat?.data?.cliSessionId : null;
    if (!taskId) return '';
    const slot = this.chatDrawerState?.codexLink;
    const capability = slot?.status === 'ready'
      ? slot.value
      : {
          state: slot?.status === 'error' ? 'failed' : 'unknown',
          canAttempt: false,
          reasonCode: slot?.status === 'error' ? 'handler-check-failed' : 'handler-status-unknown',
        };
    const baseView = codexTaskLaunchView(taskId, capability);
    const attempt = chat.codexLinkAttempt?.taskId === baseView.taskId ? chat.codexLinkAttempt : null;
    const view = attempt
      ? { ...baseView, state: attempt.state, reasonCode: attempt.reasonCode }
      : baseView;
    const messages = {
      remote: 'Opening Codex depends on the device opening this page, not the Scout server. Copy the task ID and resume it in Codex on this device.',
      unavailable: 'No supported Codex handler was found on this device. Copy the task ID and resume it in Codex.',
      failed: 'Scout could not verify the Codex handler on this device. Copy the task ID and resume it in Codex.',
      unknown: 'Checking whether this device can open Codex. The task ID remains copyable.',
    };
    let message;
    if (view.reasonCode === 'invalid-task-id') {
      message = 'This task identity cannot be opened as a link. Copy it manually only if you recognise it.';
    } else if (view.reasonCode === 'launch-failed') {
      message = 'Scout could not open Codex on this device. Copy the task ID and resume it in Codex.';
    } else if (view.reasonCode === 'copied') {
      message = 'Task ID copied. Open Codex on this device and resume that task.';
    } else if (view.reasonCode === 'copy-failed') {
      message = 'Scout could not copy automatically. Select the visible task ID and resume it in Codex.';
    } else if (view.state === 'attempting') {
      message = 'Scout asked this device to open Codex, but the browser cannot confirm success. If Codex did not open, copy the task ID and resume it.';
    } else {
      message = messages[capability.state] || messages.unknown;
    }
    const open = view.canNavigate
      ? '<button class="act" data-action="open-codex-task">open in Codex</button>'
      : '';
    const copy = view.taskId != null
      ? '<button class="act" data-action="copy-codex-task">copy task ID</button>'
      : '';
    const identity = view.taskId != null
      ? `<code data-codex-task-id>${this.esc(view.taskId)}</code>`
      : '<span>Task identity unavailable.</span>';
    return `<span class="codex-link-status meta" role="status" aria-live="polite">
      ${open}${copy}${identity}<span>${this.esc(message)}</span>
    </span>`;
  },

  chatBubble(role, text) {
    const avatar = role === 'assistant' ? scoutMarkup('explaining', 'scout-chat-avatar') : '';
    if (role === 'system' && /(?:error|failed|could not|couldn.t|timed out|not found|spawn|sandbox|refusing|cancelled)/i.test(String(text || ''))) {
      return `<div class="chat-row system"><div class="chat-msg system chat-error"><span>Scout couldn’t complete that step. Your saved work is still available.</span><details><summary>Technical details</summary><pre>${this.esc(text)}</pre></details></div></div>`;
    }
    return `<div class="chat-row ${this.esc(role)}">${avatar}<div class="chat-msg ${this.esc(role)}">${this.esc(text)}</div></div>`;
  },

  async refreshSyncStatus({ retry = false } = {}) {
    try {
      let retryStatus = null;
      if (retry) {
        const response = await fetch('/api/sync/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        retryStatus = await response.json().catch(() => null);
      }
      const status = await this.api('/api/sync/status');
      const el = document.getElementById('sync-status');
      if (!el || !status) return;
      const labels = {
        disabled: 'Local only', 'setup-required': 'Local only', synced: 'Synced', syncing: 'Backing up…',
        offline: 'Offline — saved locally', pending: 'Backup pending', 'needs-attention': 'Backup needs attention',
      };
      el.textContent = labels[status.state] || 'Backup status';
      el.dataset.state = status.state || 'disabled';
      el.title = status.error || (status.enabled ? 'Open backup details' : 'Private backup is optional');
      const pulledAt = retryStatus?.pulledAt || status.pulledAt;
      if (pulledAt && pulledAt !== this.lastSyncPullAt) {
        this.lastSyncPullAt = pulledAt;
        await this.loadOpportunities();
      }
    } catch { /* backup status never blocks the local dashboard */ }
  },

  codexNavigate(href) {
    window.location.assign(href);
  },

  openCodexTask() {
    const c = this.chat;
    const taskId = c?.engine === 'codex' ? c?.data?.cliSessionId : null;
    const capability = this.chatDrawerState?.codexLink?.value;
    const view = codexTaskLaunchView(taskId, capability);
    if (!view.canNavigate) {
      if (c) c.codexLinkAttempt = view;
      this.renderChatDrawerSnapshot();
      return;
    }
    try {
      this.codexNavigate(view.href);
      c.codexLinkAttempt = view;
    } catch {
      c.codexLinkAttempt = codexTaskLaunchView(taskId, {
        state: 'failed',
        canAttempt: false,
        reasonCode: 'launch-failed',
      });
    }
    this.renderChatDrawerSnapshot();
  },

  async copyCodexTask() {
    const c = this.chat;
    const taskId = c?.engine === 'codex' ? c?.data?.cliSessionId : null;
    const capability = this.chatDrawerState?.codexLink?.value || { state: 'unknown', canAttempt: false };
    const view = codexTaskLaunchView(taskId, capability);
    if (view.taskId == null) return;
    try {
      await navigator.clipboard.writeText(view.taskId);
      if (this.chat === c) {
        c.codexLinkAttempt = { ...view, reasonCode: 'copied' };
        this.renderChatDrawerSnapshot();
      }
    } catch {
      if (this.chat === c) {
        c.codexLinkAttempt = { ...view, reasonCode: 'copy-failed' };
        this.renderChatDrawerSnapshot();
      }
    }
  },

  setChatScoutState(state, message) {
    const el = document.querySelector('#chat-drawer .scout-character');
    if (el) applyScoutState(el, state, { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    const status = document.getElementById('scout-chat-status');
    if (status && message) status.textContent = message;
  },

  renderChatMessages() {
    const body = document.getElementById('chat-body');
    if (!body || !this.chat) return;
    body.innerHTML = this.chat.data.messages.map((m) => this.chatBubble(m.role, m.text)).join('')
      + this.cvLinkHtml()
      + this.interviewPrepPackHtml()
      + (this.chat.engine ? '' : this.chatPickerHtml());
    body.scrollTop = body.scrollHeight;
  },

  chatNearBottom(body, threshold = 80) {
    return !body || body.scrollHeight - body.scrollTop - body.clientHeight <= threshold;
  },

  scrollChatIfFollowing(body, following) {
    if (body && following) body.scrollTop = body.scrollHeight;
  },

  cvLinkHtml() {
    if (this.chat?.id === 'setup-onboarding') return '';
    const entry = (this.state.data?.opportunities || []).find((item) => item.id === this.chat.id);
    if (!entry) return '';
    const slug = this.resolveArtifactFor(entry).slug;
    return (this.chat.data.filesTouched || []).includes(`applications/${slug}/cv.typ`)
      ? `<div class="chat-msg system"><a href="#" data-action="see-cv" data-slug="${this.esc(slug)}" data-id="${this.esc(this.chat.id)}">view rendered CV</a></div>`
      : '';
  },

  interviewPrepPackHtml() {
    if (this.chat?.purpose !== 'interview-prep') return '';
    const artifact = this.chat.artifact;
    if (!artifact?.exists) {
      return '<div class="chat-msg system">No prep pack yet. Choose an engine, then send Generate pack when you are ready.</div>';
    }
    const updated = artifact.updatedAt ? ` - updated ${this.esc(new Date(artifact.updatedAt).toLocaleString())}` : '';
    return `<div class="chat-msg system"><details><summary>View prep pack${updated}</summary><pre style="white-space:pre-wrap">${this.esc(artifact.content || '')}</pre></details></div>`;
  },

  usePrepPrompt(key) {
    const c = this.chat;
    if (!c || c.purpose !== 'interview-prep') return;
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.value = c.prefills[key] || '';
    input.focus();
  },

  pickEngine(engine) {
    const val = document.getElementById('chat-input').value;
    const card = document.querySelector(`[data-engine-card="${engine}"]`);
    const selection = card?.querySelector('[data-engine-model]')?.value || '';
    const info = this.chatDrawerState?.engines?.value?.engines?.[engine];
    const status = card?.querySelector('.engine-model-status');
    if (!selection && info?.effectiveModel?.available === false) {
      if (status) status.textContent = 'Choose an available model before starting this chat.';
      return;
    }
    const model = this.selectedEngineModel(engine);
    if (selection === '__other__' && !/^[A-Za-z0-9._:-]{1,128}$/.test(String(model || ''))) {
      if (status) status.textContent = 'Enter a safe exact model ID.';
      return;
    }
    this.chat.engine = engine;
    this.chat.model = model;
    this.renderChatDrawer();
    document.getElementById('chat-input').value = val;
  },

  chatKey(ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      this.sendChat();
    }
  },

  setChatBusy(busy) {
    const send = document.getElementById('chat-send');
    const stop = document.getElementById('chat-stop');
    if (send) send.style.display = busy ? 'none' : '';
    if (stop) stop.style.display = busy ? '' : 'none';
  },

  async readSse(response, onEvent) {
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) onEvent(event, JSON.parse(data));
      }
    }
  },

  async sendChat() {
    const c = this.chat;
    if (!c || c.streaming) return;
    if (!c.engine) return alert('Pick an engine first.');
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    c.streaming = true;
    this.setChatScoutState('thinking', 'I’m thinking…');
    input.value = '';
    this.setChatBusy(true);
    const body = document.getElementById('chat-body');
    body.insertAdjacentHTML('beforeend', this.chatBubble('user', text));
    body.insertAdjacentHTML('beforeend', `<div class="chat-row assistant">${scoutMarkup('explaining', 'scout-chat-avatar')}<div class="chat-msg assistant" id="chat-live">&hellip;</div></div>`);
    this.initScoutSprites(body);
    body.scrollTop = body.scrollHeight;
    let live = '';
    const startedWithoutSession = !c.data.cliSessionId;
    let terminalError = null;
    try {
      const resp = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: c.id, purpose: c.purpose, engine: c.engine, model: c.model || null, text, mode: c.mode }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (!resp.ok || !ct.includes('event-stream')) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `request failed (${resp.status})`);
      }
      await this.readSse(resp, (event, data) => {
        const active = this.chat === c && document.getElementById('chat-body') === body;
        const following = active && this.chatNearBottom(body);
        const liveEl = active ? body.querySelector('#chat-live') : null;
        if (event === 'delta' && liveEl) {
          this.setChatScoutState('explaining', 'I’m putting the answer together…');
          if (live) {
            liveEl.removeAttribute('id');
            liveEl.closest('.chat-row')?.insertAdjacentHTML('afterend', `<div class="chat-row assistant">${scoutMarkup('explaining', 'scout-chat-avatar')}<div class="chat-msg assistant" id="chat-live"></div></div>`);
            this.initScoutSprites(body);
          }
          live = data.text;
          const nextLive = body.querySelector('#chat-live');
          if (nextLive) nextLive.textContent = data.text;
        }
        if (event === 'tool' && liveEl) {
          const state = activityState(data.activity || data.label);
          this.setChatScoutState(state, state === 'searching' ? 'I’m checking the advert…' : state === 'writing' ? 'I’m updating your files…' : 'I’m working on it…');
        }
        if (event === 'done') {
          this.setChatScoutState('success', 'Done. Have a look.');
          c.data.messages.push(
            { role: 'user', text },
            ...(data.updates?.length ? data.updates : [data.text]).filter(Boolean).map((update) => ({ role: 'assistant', text: update })),
          );
          c.data.cliSessionId = data.sessionId;
          if (data.filesTouched) c.data.filesTouched = data.filesTouched;
        }
        if (event === 'error') {
          this.setChatScoutState('warning', 'I hit a problem, but your completed work is safe.');
          terminalError = data.message;
          c.data.messages.push({ role: 'user', text }, { role: 'system', text: data.message });
          if (data.sessionId) c.data.cliSessionId = data.sessionId;
          if (data.filesTouched) c.data.filesTouched = data.filesTouched;
        }
        this.scrollChatIfFollowing(body, following);
      });
    } catch (e) {
      this.setChatScoutState('warning', 'I couldn’t complete that turn.');
      terminalError = e.message;
      c.data.messages.push({ role: 'user', text }, { role: 'system', text: e.message });
    }
    c.streaming = false;
    c.mode = null;
    await this.refreshCvFilesIfTouched(c.data.filesTouched);
    if (this.chat !== c) return;
    if (terminalError && startedWithoutSession) {
      const message = terminalError;
      await this.openChat(c.id, c.purpose === 'interview-prep' ? 'interviewPrep' : 'ask', null, c.purpose);
      if (this.chat?.id === c.id
          && !this.chat.data.messages.some((m) => m.role === 'system' && m.text === message)) {
        this.chat.data.messages.push({ role: 'system', text: message });
        this.renderChatDrawer();
      }
      return;
    }
    if (c.purpose === 'interview-prep') await this.refreshInterviewPrepArtifact(c);
    const draft = document.getElementById('chat-input')?.value || '';
    const following = this.chatNearBottom(body);
    const previousScrollTop = body.scrollTop;
    this.renderChatDrawer();
    document.getElementById('chat-input').value = draft;
    if (!following) document.getElementById('chat-body').scrollTop = previousScrollTop;
    this.refreshUsage(c);
    void this.refreshCodexDeepLink(c);
  },

  async refreshInterviewPrepArtifact(target = this.chat) {
    if (!target || target.purpose !== 'interview-prep') return;
    try {
      const r = await this.api(`/api/chat?id=${encodeURIComponent(target.id)}&purpose=interview-prep`);
      if (this.chat === target) target.artifact = r.artifact || target.artifact;
    } catch { /* a saved transcript remains usable if the pack cannot be read */ }
  },

  async stopChat(target = this.chat) {
    if (!target) return false;
    try {
      const response = await fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: target.id, purpose: target.purpose }),
      });
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      return true;
    } catch (e) {
      if (this.chat === target) {
        const body = document.getElementById('chat-body');
        if (body) body.insertAdjacentHTML('beforeend', this.chatBubble('system', `Could not stop: ${e.message}`));
      }
      return false;
    }
  },

  async closeChat() {
    if (this.chat && this.chat.streaming) {
      if (!confirm('A turn is still running - close and stop it?')) return;
      if (!await this.stopChat(this.chat)) return;
    }
    if (this.chat?.pollTimer) clearTimeout(this.chat.pollTimer);
    this.chatOpenSeq += 1;
    if (this.chatDrawerState && this.chatDrawerState.chatId !== null) {
      this.chatDrawerState = reduceChatDrawer(this.chatDrawerState, {
        type: 'chat/closed',
        chatId: this.chatDrawerState.chatId,
        generation: this.chatDrawerState.generation,
      });
    }
    this.chat = null;
    document.getElementById('chat-drawer').classList.add('hidden');
  },

  async refreshUsage(target = this.chat) {
    const drawer = this.chatDrawerState;
    if (!target || !drawer || drawer.chatId !== target.id) return;
    const requestGeneration = drawer.usage.requestGeneration + 1;
    this.chatDrawerState = reduceChatDrawer(drawer, {
      type: 'usage/requested',
      chatId: drawer.chatId,
      generation: drawer.generation,
      requestGeneration,
    });
    let u;
    try {
      u = await this.api('/api/usage');
      if (!u || u.error) throw new Error('usage unavailable');
    } catch {
      const before = this.chatDrawerState;
      this.chatDrawerState = reduceChatDrawer(before, {
        type: 'usage/rejected',
        chatId: drawer.chatId,
        generation: drawer.generation,
        requestGeneration,
        error: 'usage unavailable',
      });
      if (this.chatDrawerState !== before) this.renderChatDrawerSnapshot();
      return;
    }
    const before = this.chatDrawerState;
    this.chatDrawerState = reduceChatDrawer(before, {
      type: 'usage/resolved',
      chatId: drawer.chatId,
      generation: drawer.generation,
      requestGeneration,
      value: u,
    });
    if (this.chatDrawerState !== before) this.renderChatDrawerSnapshot();
  },

  async refreshCodexDeepLink(target = this.chat) {
    const drawer = this.chatDrawerState;
    if (!target || target.engine !== 'codex' || !target.data?.cliSessionId
        || !drawer || drawer.chatId !== target.id) return;
    const requestGeneration = drawer.codexLink.requestGeneration + 1;
    this.chatDrawerState = reduceChatDrawer(drawer, {
      type: 'codexLink/requested',
      chatId: drawer.chatId,
      generation: drawer.generation,
      requestGeneration,
    });
    let value;
    try {
      value = await this.api('/api/device/codex-deep-link');
      if (!value || !['supported', 'unavailable', 'failed', 'remote', 'unknown'].includes(value.state)) {
        throw new Error('invalid capability');
      }
    } catch {
      const before = this.chatDrawerState;
      this.chatDrawerState = reduceChatDrawer(before, {
        type: 'codexLink/rejected',
        chatId: drawer.chatId,
        generation: drawer.generation,
        requestGeneration,
        error: 'Codex link capability unavailable',
      });
      if (this.chatDrawerState !== before) this.renderChatDrawerSnapshot();
      return;
    }
    const before = this.chatDrawerState;
    this.chatDrawerState = reduceChatDrawer(before, {
      type: 'codexLink/resolved',
      chatId: drawer.chatId,
      generation: drawer.generation,
      requestGeneration,
      value,
    });
    if (this.chatDrawerState !== before) this.renderChatDrawerSnapshot();
  },

  openChatForCv() {
    if (!this.cvState.slug) return alert('Open a tailored (application) CV first.');
    if (!this.cvState.opportunityId) {
      return alert('Open this CV from its opportunity card so Scout knows which job chat it belongs to.');
    }
    this.openChat(this.cvState.opportunityId, 'tweak', null, 'job', this.cvState.slug || null);
  },

  async handoffChat() {
    const c = this.chat;
    if (!c || c.streaming) return;
    const to = c.engine === 'claude' ? 'codex' : 'claude';
    if (!confirm(`Summarise this conversation and hand off to ${to}?`)) return;
    c.streaming = true;
    this.setChatBusy(true);
    const body = document.getElementById('chat-body');
    let completed = false;
    let handoffError = null;
    let handoffStateChanged = false;
    try {
      const resp = await fetch('/api/chat/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: c.id, purpose: c.purpose }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (!resp.ok || !ct.includes('event-stream')) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `request failed (${resp.status})`);
      }
      await this.readSse(resp, (event, data) => {
        const active = this.chat === c && document.getElementById('chat-body') === body;
        const following = active && this.chatNearBottom(body);
        if (active && (event === 'status' || event === 'error')) {
          body.insertAdjacentHTML('beforeend', this.chatBubble('system', data.message));
        }
        if (event === 'done') completed = true;
        if (event === 'error') handoffError = data.message;
        if (event === 'error' && data.engine) {
          handoffStateChanged = true;
          c.engine = data.engine;
          c.data.engine = data.engine;
          c.data.cliSessionId = data.sessionId || null;
          if (data.filesTouched) c.data.filesTouched = data.filesTouched;
          const chip = document.querySelector('#chat-drawer .chat-head .chip');
          if (active && chip) chip.textContent = data.engine;
        }
        this.scrollChatIfFollowing(body, following);
      });
    } catch (e) {
      handoffError = e.message;
      if (this.chat === c) body.insertAdjacentHTML('beforeend', this.chatBubble('system', e.message));
    }
    c.streaming = false;
    if (this.chat !== c) return;
    if (!completed) {
      if (handoffStateChanged) {
        const message = handoffError;
        await this.openChat(c.id, c.purpose === 'interview-prep' ? 'interviewPrep' : 'ask', null, c.purpose);
        if (message && this.chat?.id === c.id
            && !this.chat.data.messages.some((m) => m.role === 'system' && m.text === message)) {
          this.chat.data.messages.push({ role: 'system', text: message });
          this.renderChatDrawer();
        }
        return;
      }
      this.setChatBusy(false);
      return;
    }
    const following = this.chatNearBottom(body);
    const previousScrollTop = body.scrollTop;
    await this.openChat(
      c.id,
      c.purpose === 'interview-prep' ? 'interviewPrep' : 'ask',
      null,
      c.purpose,
    ); // reload transcript, new engine badge, fresh composer
    if (!following && this.chat?.id === c.id) {
      document.getElementById('chat-body').scrollTop = previousScrollTop;
    }
  },

  showTab(tab) {
    this.state.tab = tab;
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    ['jobs', 'speculative', 'shortlist', 'pipeline', 'all', 'reports', 'cv'].forEach((t) =>
      document.getElementById(`tab-${t}`)?.classList.toggle('hidden', t !== tab));
    window.scrollTo?.(0, 0);
    if (tab === 'jobs') this.renderJobs();
    if (tab === 'speculative') this.renderSpeculative();
    if (tab === 'shortlist') this.renderShortlist();
    if (tab === 'pipeline') this.renderPipeline();
    if (tab === 'reports') this.renderReports();
    if (tab === 'cv') this.renderCv();
  },

  runAction(element) {
    const { action, id, key, tab, date, index, slug, prefill, prompt, engine } = element.dataset;
    switch (action) {
      case 'show-discovery': return this.showDiscovery();
      case 'dismiss-discoveries': return this.dismissDiscoveries();
      case 'sort': return this.setSort(key);
      case 'open-entry': return this.openEntry(tab, id);
      case 'open-report': return this.openReport(date);
      case 'open-scan-report': return this.openScanReport(date);
      case 'open-scan-result': return this.openScanResult();
      case 'close-scan-result': return this.closeScanResult();
      case 'complete-stage': return this.completeStage(id, Number(index));
      case 'toggle-source': return this.toggleSourcePanel(id, element);
      case 'mark-applied': return this.markApplied(id);
      case 'mark-accepted': return this.markAccepted(id);
      case 'mark-rejected': return this.rejectOpportunity(id);
      case 'see-cv': return this.seeCv(slug, id || null);
      case 'choose-cv-options': return this.reviewCvOptions(id);
      case 'see-cover-letter': return this.seeCoverLetter(slug);
      case 'open-chat': return this.openChat(id, prefill);
      case 'open-company-history': return this.openCompanyHistory(id);
      case 'open-interview-prep': return this.openInterviewPrep(id);
      case 'remove-company-communication': return this.removeCompanyCommunication(id);
      case 'open-company-role-chat': return this.openCompanyRoleChat(id);
      case 'close-company-history': return this.closeCompanyHistory();
      case 'open-cv': return this.openCv(element.dataset.cvPath, slug || null, element.dataset.opportunityId || null);
      case 'toggle-cv-create': return this.toggleCvCreate();
      case 'start-cv-create': return this.startCvCreate();
      case 'save-cv': return this.saveCv();
      case 'render-cv': return this.renderCvOnly();
      case 'download-cv': return this.downloadCv();
      case 'open-chat-for-cv': return this.openChatForCv();
      case 'fullscreen-cv': return this.fullscreenCv();
      case 'open-cv-pdf': return this.openCvPdf();
      case 'run-cv-quality-review': return this.runCvQualityReview();
      case 'review-evidence-for-master': return this.reviewEvidenceForMaster();
      case 'use-prep-prompt': return this.usePrepPrompt(prompt);
      case 'handoff-chat': return this.handoffChat();
      case 'open-codex-task': return this.openCodexTask();
      case 'copy-codex-task': return this.copyCodexTask();
      case 'close-chat': return this.closeChat();
      case 'send-chat': return this.sendChat();
      case 'stop-chat': return this.stopChat();
      case 'pick-engine': return this.pickEngine(engine);
      case 'triage-yes': return this.triageYes(id);
      case 'triage-no': return this.triageNo(id);
      case 'undo-dismiss': return this.undoDismiss(id);
      case 'remove-shortlist': return this.removeFromShortlist(id);
      case 'record-feedback': return this.recordJobFeedback(id);
      case 'restore': return this.restoreEntry(id);
      default: return undefined;
    }
  },

  bindDelegatedActions() {
    document.addEventListener?.('click', (event) => {
      const action = event.target.closest?.('[data-action]');
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        this.runAction(action);
        return;
      }
      if (event.target.closest?.('a, button, input, select, textarea, label, form')) return;
      const card = event.target.closest?.('.card[data-id]');
      if (card) this.expandCard(card.dataset.id, card);
    });
    document.addEventListener?.('keydown', (event) => {
      if (event.target.matches?.('[data-keydown-action="chat-key"]')) {
        this.chatKey(event);
        return;
      }
      if (!['Enter', ' '].includes(event.key)) return;
      const action = event.target.closest?.('[data-action]');
      if (action) {
        event.preventDefault();
        this.runAction(action);
        return;
      }
      const card = event.target.closest?.('.card[data-id]');
      if (card) {
        event.preventDefault();
        this.expandCard(card.dataset.id, card);
      }
    });
    document.addEventListener?.('change', (event) => {
      const element = event.target;
      if (element.dataset.action === 'select-report') this.openReport(element.value);
      else if (element.dataset.changeAction === 'commute-filter') {
        this.setCommuteFilter(element.dataset.key, element.type === 'checkbox' ? element.checked : element.value);
      } else if (element.dataset.changeAction === 'cv-zoom') this.setCvZoom(element.value);
      else if (element.dataset.engineModel) this.onEngineModelChange(element);
    });
    document.addEventListener?.('input', (event) => {
      if (event.target.dataset.inputAction !== 'cv-dirty') return;
      this.cvState.dirty = true;
      this.cvState.content = event.target.value;
      const dirty = document.getElementById('cv-dirty');
      if (dirty) dirty.textContent = 'unsaved';
    });
    document.addEventListener?.('submit', (event) => {
      if (event.target.dataset.submitAction !== 'save-company-communication') return;
      event.preventDefault();
      this.saveCompanyCommunication();
    });
    document.addEventListener?.('dragstart', (event) => {
      const card = event.target.closest?.('.pipeline-card[data-id]');
      if (!card) return;
      this.pipelineDragId = card.dataset.id;
      card.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', card.dataset.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    document.addEventListener?.('dragover', (event) => {
      const column = event.target.closest?.('.pipeline-column[data-pipeline-status]');
      if (!column || !this.pipelineDragId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      column.classList.add('drag-over');
    });
    document.addEventListener?.('dragleave', (event) => {
      const column = event.target.closest?.('.pipeline-column[data-pipeline-status]');
      if (column && !column.contains(event.relatedTarget)) column.classList.remove('drag-over');
    });
    document.addEventListener?.('drop', (event) => {
      const column = event.target.closest?.('.pipeline-column[data-pipeline-status]');
      const id = this.pipelineDragId || event.dataTransfer?.getData('text/plain');
      if (!column || !id) return;
      event.preventDefault();
      column.classList.remove('drag-over');
      this.pipelineDragId = null;
      this.movePipelineEntry(id, column.dataset.pipelineStatus);
    });
    document.addEventListener?.('dragend', (event) => {
      event.target.closest?.('.pipeline-card')?.classList.remove('dragging');
      document.querySelectorAll?.('.pipeline-column.drag-over').forEach((column) => column.classList.remove('drag-over'));
      this.pipelineDragId = null;
    });
  },

  async checkForAppUpdate(force = false) {
    try {
      const response = await fetch('/api/update/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force }) });
      const update = await response.json();
      if (!response.ok) throw new Error(update.error || 'Update check failed');
      this.renderUpdateBanner(update);
      return update;
    } catch (error) {
      if (force) this.renderUpdateBanner({ error: error.message });
      return null;
    }
  },

  renderUpdateBanner(update) {
    const banner = document.getElementById?.('update-banner');
    if (!banner) return;
    banner.replaceChildren();
    if (!update?.available && !update?.error) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    const copy = document.createElement('p');
    const downloadedReady = update.downloaded?.version === update.latestVersion;
    const installerHandoff = (downloaded) => downloaded?.name && downloaded?.locationHint
      ? `Close Scout, then run ${downloaded.name}. Find it at ${downloaded.locationHint}.`
      : null;
    const readyHandoff = downloadedReady ? installerHandoff(update.downloaded) : null;
    copy.textContent = update.error
      ? `Scout could not check for updates: ${update.error}`
      : `Scout ${update.latestVersion} is available.${readyHandoff ? ` The package is verified. ${readyHandoff}` : downloadedReady ? ' The verified package is ready.' : ''}`;
    banner.append(copy);
    const actions = document.createElement('div'); actions.className = 'update-banner-actions';
    if (update.url) {
      const notes = document.createElement('a'); notes.className = 'act'; notes.href = update.url; notes.target = '_blank'; notes.rel = 'noreferrer'; notes.textContent = 'Release notes'; actions.append(notes);
    }
    if (update.canDownload && update.package && update.downloaded?.version !== update.latestVersion) {
      const download = document.createElement('button'); download.type = 'button'; download.className = 'act primary'; download.textContent = 'Download verified update';
      download.addEventListener('click', async () => {
        download.disabled = true; download.textContent = 'Verifying…';
        try {
          const response = await fetch('/api/update/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Download failed');
          if (!result.downloaded?.name || !result.downloaded?.version || !result.downloaded?.locationHint) throw new Error('Downloaded package response was incomplete');
          copy.textContent = `Scout ${result.downloaded.version} is verified. ${installerHandoff(result.downloaded)}`;
          download.remove();
        } catch (error) { copy.textContent = `Update download failed: ${error.message}`; download.disabled = false; download.textContent = 'Try again'; }
      });
      actions.append(download);
    }
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'act'; dismiss.textContent = 'Later'; dismiss.addEventListener('click', () => banner.classList.add('hidden')); actions.append(dismiss);
    banner.append(actions);
  },

  init() {
    ScoutModal.register(document.getElementById?.('cv-options-overlay'), {
      initialFocus: '#cv-options-title', onEscape: () => this.closeCvOptions(),
    });
    ScoutModal.register(document.getElementById?.('chat-drawer'), {
      initialFocus: '[data-action="close-chat"]', onEscape: () => this.closeChat(),
    });
    ScoutModal.register(document.getElementById?.('company-drawer'), {
      initialFocus: '[data-action="close-company-history"]', onEscape: () => this.closeCompanyHistory(),
    });
    ScoutModal.register(document.getElementById?.('scan-result-overlay'), {
      initialFocus: '#scan-result-title', onEscape: () => this.closeScanResult(),
    });
    this.registerServiceWorker();
    window.addEventListener?.('offline', () => this.setHostAvailable(false));
    window.addEventListener?.('online', () => this.loadOpportunities().catch(() => this.setHostAvailable(false)));
    document.querySelectorAll('nav button').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.id === 'scout-settings') window.ScoutSetup?.openSettings?.();
        else if (b.dataset.tab) this.showTab(b.dataset.tab);
      }));
    document.getElementById?.('scan-now')?.addEventListener('click', () => this.scanNow());
    document.getElementById?.('sync-status')?.addEventListener('click', () => window.ScoutSetup?.openBackupDetails?.());
    document.getElementById?.('cv-options-cancel')?.addEventListener('click', () => this.closeCvOptions());
    document.getElementById?.('cv-options-continue')?.addEventListener('click', () => this.startCvFromOptions());
    this.bindDelegatedActions();
    window.addEventListener?.('focus', () => {
      this.refreshSyncStatus({ retry: true });
      this.serviceWorkerRegistration?.update?.();
      this.checkUiBuild();
    });
    document.addEventListener?.('visibilitychange', () => {
      if (!document.hidden) {
        this.refreshSyncStatus({ retry: true });
        this.serviceWorkerRegistration?.update?.();
        this.checkUiBuild();
      }
    });
    this.loadOpportunities();
    this.reattachScanOperation();
    this.refreshSyncStatus();
    this.checkUiBuild();
    window.setTimeout?.(() => this.checkForAppUpdate(false), 2500);
    window.setInterval?.(() => this.refreshSyncStatus(), 5 * 60 * 1000);
    window.setInterval?.(() => {
      this.serviceWorkerRegistration?.update?.();
      this.checkUiBuild();
    }, 5 * 60 * 1000);
  },
};
window.Scout = Scout;
Scout.init();
