const STEPS = ['Welcome', 'AI provider', 'Your search', 'Adzuna', 'Import CV', 'AI hand-off', 'First scan'];
// Keep the existing storage key so people who previously dismissed setup are
// not forced back into it after upgrading. It now represents an intentional
// decision to finish the optional AI enrichment later.
const SETUP_DEFERRED_KEY = 'scout.setup.legacySkipped.v1';
const SUPPORTED_CV = /\.(pdf|docx|md|markdown|txt)$/i;
const DISMISSIBLE_VIEWS = new Set(['hub', 'section', 'retune', 'backup-details']);
// Sunday = 0, matching ui/lib/scheduler.mjs. Kept as a literal here because
// setup.js stays self-contained so a browser attached to a pre-update server
// can still boot.
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
// Alternating splits the week so the two providers never scan on the same day.
export const ALTERNATING_DAYS = Object.freeze({ primary: [0, 1, 3, 5], 'second-pass': [2, 4, 6] });
export const ALTERNATING_WEEKDAYS = Object.freeze({ primary: [1, 3, 5], 'second-pass': [2, 4] });
const DAY_PRESETS = [
  ['every', 'Every day'],
  ['alternating', 'Alternating with the other provider'],
  ['alternating-weekdays', 'Alternating weekdays (no weekends)'],
  ['weekdays', 'Weekdays only'],
  ['custom', 'Custom days'],
];

export function presetDays(preset, mode = 'primary') {
  if (preset === 'alternating') return [...(ALTERNATING_DAYS[mode] || ALTERNATING_DAYS.primary)];
  if (preset === 'alternating-weekdays') return [...(ALTERNATING_WEEKDAYS[mode] || ALTERNATING_WEEKDAYS.primary)];
  if (preset === 'weekdays') return [1, 2, 3, 4, 5];
  return [...EVERY_DAY];
}

export function matchingPreset(days, mode = 'primary') {
  const value = [...new Set(days || [])].sort((a, b) => a - b).join(',');
  if (!value || value === EVERY_DAY.join(',')) return 'every';
  if (value === presetDays('alternating', mode).join(',')) return 'alternating';
  if (value === presetDays('alternating-weekdays', mode).join(',')) return 'alternating-weekdays';
  if (value === presetDays('weekdays').join(',')) return 'weekdays';
  return 'custom';
}

// Settings section -> the STEPS index that edits it. Named so the mapping is
// stated once instead of being recomputed as a literal at each call site.
export const RETUNE_ENTRY_STEPS = Object.freeze({
  search: STEPS.indexOf('Your search'),
  sources: STEPS.indexOf('Adzuna'),
});
const SETTINGS_SECTIONS = [
  ['search', 'Search & profile', 'Roles, locations, compensation, commute and exclusions'],
  ['providers', 'AI providers', 'Choose the signed-in provider Scout uses'],
  ['sources', 'Sources', 'Public sources and optional Adzuna credentials'],
  ['scans', 'Scans & schedule', 'Run a supervised scan and manage daily jobs'],
  ['backup', 'Backup', 'Private repository status, recovery and manual backup'],
  ['remote', 'Remote access', 'Owner-only access through Tailscale'],
  ['app', 'App & device', 'Application updates and device startup'],
];

export function splitList(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildConfig(form, current = {}) {
  const salary = String(form.salaryMinimum || '').trim();
  return {
    locale: String(form.locale || current.locale || 'en-GB').trim(),
    currency: String(form.currency || current.currency || 'GBP').trim().toUpperCase(),
    timezone: String(form.timezone || current.timezone || 'Europe/London').trim(),
    profile: {
      ...(current.profile || {}),
      displayName: String(form.displayName || '').trim(),
      tone: String(form.tone || '').trim(),
    },
    search: {
      ...(current.search || {}),
      roleFamilies: splitList(form.roleFamilies),
      sectors: splitList(form.sectors),
      locations: splitList(form.locations),
      exclusions: splitList(form.exclusions),
      salaryMinimum: salary === '' ? null : Number(salary),
    },
    commute: {
      ...(current.commute || {}),
      origin: String(form.commuteOrigin || '').trim(),
      mode: String(form.commuteMode || 'either'),
      maxMinutes: Number(form.commuteMax || 180),
      includeUnknown: Boolean(form.includeUnknown),
    },
  };
}

export function validateCvName(name) {
  if (!SUPPORTED_CV.test(String(name || ''))) {
    throw new Error('Choose a PDF, DOCX, Markdown or text CV.');
  }
  return true;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

export function formatLocalDateTime(value, locale = 'en-GB') {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'pending';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function handoffAction(ready) {
  return { label: ready ? 'Continue to first scan' : 'Activate a proposal to continue', defer: false, ready: Boolean(ready) };
}

export function shouldAutoRunFirstScan(scanHealth = {}, ready = true) {
  return Boolean(ready && !scanHealth.lastRunAt);
}

export function shouldRequestRecoveryKey(status = {}, pendingRecoveryKey = null) {
  return status.requestAccess === 'local' && status.sync?.enabled && !pendingRecoveryKey;
}

export function scanOutcomeSummary(scanHealth = {}) {
  const reviewed = Number(scanHealth.candidatesFound || 0);
  const kept = Number(scanHealth.keepersAdded || 0);
  const discarded = scanHealth.discarded || {};
  const labels = {
    hard_exclusion: 'hard exclusions', mandatory_unmet: 'mandatory gates',
    below_threshold: 'below threshold', provider_discarded: 'assessment discards',
  };
  const breakdown = Object.entries(discarded).filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${count} ${labels[key] || key.replaceAll('_', ' ')}`);
  return { reviewed, kept, headline: `${reviewed} reviewed, ${kept} kept`, breakdown };
}

export function operationElapsed(operation, now = Date.now()) {
  const started = Date.parse(operation?.startedAt || '');
  if (!Number.isFinite(started)) return 'starting';
  const finished = Date.parse(operation?.finishedAt || '');
  const end = Number.isFinite(finished) ? finished : now;
  const seconds = Math.max(0, Math.floor((end - started) / 1000));
  return seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
}

export function operationRemaining(operation, now = Date.now()) {
  const estimate = operation?.estimate;
  const started = Date.parse(operation?.startedAt || '');
  if (!estimate || !Number.isFinite(started)) return '';
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const lower = Number(estimate.totalSecondsLow || 0);
  const upper = Number(estimate.totalSecondsHigh || 0);
  if (elapsed > upper) {
    return `Taking longer than the recent ${Math.max(1, Math.ceil(lower / 60))}–${Math.max(1, Math.ceil(upper / 60))} min range — Scout is still working`;
  }
  const lowMinutes = Math.max(0, Math.floor((lower - elapsed) / 60));
  const highMinutes = Math.max(1, Math.ceil((upper - elapsed) / 60));
  return lowMinutes < 1 ? `About ${highMinutes} min or less remaining` : `About ${lowMinutes}–${highMinutes} min remaining`;
}

function escapeProfileText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function profileRules(profile, section, field = null, strengths = null) {
  const lists = field ? [profile?.[section]?.[field] || []] : Object.values(profile?.[section] || {});
  return lists.flat()
    .filter((rule) => !strengths || strengths.includes(rule.strength))
    .map((rule) => rule.value);
}

function profileRuleText(profile, section, field, strengths) {
  const values = profileRules(profile, section, field, strengths);
  return values.length ? escapeProfileText(values.join(', ')) : 'None recorded';
}

export function searchProfileReviewHtml(state = {}) {
  const draft = state.draft || null;
  const published = state.published || null;
  const compensation = draft?.compensation || {};
  const confirmedExclusions = profileRules(draft, 'negative', null, ['hard-exclusion']);
  const draftJson = draft ? escapeProfileText(JSON.stringify(draft, null, 2)) : '';
  const noDraft = draft ? '' : '<p>No complete draft is available yet. Migrate or save a complete draft before publishing.</p>';
  const compensationText = draft
    ? `${escapeProfileText(compensation.minimum == null ? 'No minimum' : `${compensation.currency || 'currency not set'} ${compensation.minimum} per ${compensation.period}`)}; unknown compensation facts: ${escapeProfileText(compensation.unknownPolicy || 'not configured')}.`
    : 'No compensation policy recorded.';
  return `<section class="setup-callout" id="search-profile-review"><h3>Review your published search profile</h3>
    ${noDraft}
    <section><h4>Primary work</h4><p>${profileRuleText(draft, 'target', 'primaryTitles', null)}</p></section>
    <section><h4>Adjacent work</h4><p>${profileRuleText(draft, 'target', 'sectors', null)}</p></section>
    <section><h4>Mandatory requirements</h4><p>${profileRuleText(draft, 'target', null, ['mandatory'])}</p></section>
    <section><h4>Preferences</h4><p>${profileRuleText(draft, 'target', null, ['strong-preference', 'nice-to-have', 'neutral'])}</p></section>
    <section><h4>Confirmed exclusions</h4><p>${confirmedExclusions.length ? escapeProfileText(confirmedExclusions.join(', ')) : 'None recorded'}</p></section>
    <section><h4>Accepted locations and working patterns</h4><p>${profileRuleText(draft, 'target', 'locations', null)}</p></section>
    <section><h4>Compensation and unknown handling</h4><p>${compensationText}</p></section>
    <section><h4>Focused, balanced or exploratory breadth</h4><p>This draft does not make breadth a hard rule; review it as focused, balanced or exploratory before publishing.</p></section>
    <p class="meta">Unconfirmed inferences remain non-blocking until you explicitly confirm them.</p>
    ${published ? `<p>Published version: ${escapeProfileText(published.id)}</p>` : '<p>Not yet published.</p>'}
    ${draft ? `<details><summary>Edit the complete validated draft</summary><label class="setup-field wide">Complete draft JSON<textarea id="search-profile-draft" rows="16">${draftJson}</textarea></label><p><button id="search-profile-save" class="act" type="button">Save complete draft</button></p></details><label class="setup-field"><span><input id="search-profile-confirm" type="checkbox"> I reviewed this complete profile and want to publish it</span></label><p><button id="search-profile-publish" class="act primary" type="button">Publish this reviewed profile</button></p>` : ''}
  </section>`;
}

async function requestJson(pathname, options) {
  const response = await fetch(pathname, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function fieldValue(id) {
  return document.getElementById(id)?.value || '';
}

const Setup = {
  step: 0,
  status: null,
  imported: null,
  busy: false,
  preferenceStep: 0,
  preferenceDraft: null,
  incrementalSection: null,
  proposal: null,
  restoredPreferences: null,
  pendingRecoveryKey: null,
  settingsOpen: false,
  view: 'closed',
  settingsSection: null,
  refreshSequence: 0,
  statusRetry: null,
  searchProfile: null,
  operations: { proposal: null, scan: null },
  operationTimers: {},
  backgroundOperations: new Set(),
  showVerificationPass: false,
  // The wizard step a retune or resume began from. Back returns to the settings
  // hub from that step rather than walking further into first-run onboarding.
  retuneEntryStep: null,
  retuneSubtitle: null,

  el(id) { return document.getElementById(id); },

  // Settings sections open the wizard step that actually edits them. Numeric
  // step arithmetic at each call site previously landed one step early, so
  // "Retune my search" opened the AI provider question.
  enterRetune(section) {
    const entry = RETUNE_ENTRY_STEPS[section];
    if (!Number.isInteger(entry) || entry < 0) throw new Error(`unknown retune section: ${section}`);
    this.view = 'retune';
    this.step = entry;
    this.retuneEntryStep = entry;
    this.retuneSubtitle = null;
    this.preferenceStep = 0;
    this.preferenceDraft = null;
    this.render();
  },

  // Unfinished proposal or scan work is resumed here. An established workspace
  // must never be dropped into the blocking first-run wizard: it keeps a close
  // control and a route back to settings, otherwise a staged-but-unactivated
  // proposal locks the dashboard away on every reload.
  resumeAt(step) {
    const established = Boolean(this.status?.established || this.status?.setupComplete);
    this.view = established ? 'retune' : 'onboarding';
    this.step = step;
    this.retuneEntryStep = established ? step : null;
    this.retuneSubtitle = established ? 'Finish or discard the setup work Scout has staged.' : null;
    this.el('setup-overlay').classList.remove('hidden');
    this.render();
  },

  atRetuneEntry() {
    return this.view === 'retune' && this.retuneEntryStep !== null && this.step === this.retuneEntryStep;
  },

  focusDialogTitle() {
    window.ScoutModal?.focus(this.el('setup-overlay'), '#setup-title');
  },

  async init() {
    if (!this.el('setup-overlay')) return;
    this.el('setup-back').addEventListener('click', () => {
      if (this.view === 'section') this.showSettingsHub();
      else this.move(-1);
    });
    this.el('setup-next').addEventListener('click', () => this.next());
    this.el('setup-skip').addEventListener('click', () => this.deferSetup());
    this.el('setup-close').addEventListener('click', () => this.closeSettings());
    this.el('setup-overlay').addEventListener('click', (event) => {
      if (event.target === this.el('setup-overlay')) this.closeSettings();
    });
    window.ScoutModal?.register(this.el('setup-overlay'), {
      initialFocus: '#setup-title', onEscape: () => this.closeSettings(),
    });
    await this.refreshStatus();
  },

  async refreshStatus({ keepOpen = false } = {}) {
    const sequence = ++this.refreshSequence;
    const retryContext = this.statusRetry?.context || {
      view: this.view,
      step: this.step,
      preferenceStep: this.preferenceStep,
      settingsSection: this.settingsSection,
      incrementalSection: this.incrementalSection,
    };
    if (this.step === 2 && this.preferenceDraft) this.capturePreferenceQuestion();
    try {
      const status = await requestJson('/api/setup/status');
      if (sequence !== this.refreshSequence) return;
      this.status = status;
      if (status.bootstrap) {
        this.statusRetry = null;
        this.view = 'onboarding';
        this.proposal = null;
        this.el('setup-overlay').classList.remove('hidden');
        this.renderBootstrap();
        return;
      }
      if (shouldRequestRecoveryKey(status, this.pendingRecoveryKey)) {
        const pending = await requestJson('/api/sync/recovery-key', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        if (sequence !== this.refreshSequence) return;
        this.pendingRecoveryKey = pending.recoveryKey || null;
      }
      const proposal = await requestJson('/api/setup/proposal');
      if (sequence !== this.refreshSequence) return;
      this.proposal = proposal.proposal;
      await this.reattachOperations();
      if (sequence !== this.refreshSequence) return;
      this.statusRetry = null;
      window.Scout?.applyWorkspaceConfig?.(status.config);
      this.el('setup-title').textContent = status.established ? 'Scout settings' : 'Set up Scout';
      this.el('setup-subtitle').textContent = status.established
        ? 'Review or retune your existing private workspace.'
        : 'A private workspace, tuned to your search.';
      const proposalRunning = ['queued', 'running'].includes(this.operations.proposal?.status);
      const scanRunning = ['queued', 'running'].includes(this.operations.scan?.status);
      if (!keepOpen && (proposalRunning || (this.proposal && !this.status.ready))) {
        this.resumeAt(5);
        return;
      }
      if (!keepOpen && scanRunning && !this.status.setupComplete) {
        this.resumeAt(6);
        return;
      }
      if (keepOpen && DISMISSIBLE_VIEWS.has(this.view)) {
        this.el('setup-overlay').classList.remove('hidden');
        this.render();
        return;
      }
      const skipped = this.status.trackerExists && localStorage.getItem(SETUP_DEFERRED_KEY) === 'true';
      const pending = this.status.pendingSetupSections || [];
      if (!keepOpen && this.pendingRecoveryKey) {
        this.view = 'incremental';
        this.el('setup-overlay').classList.remove('hidden');
        this.render();
        return;
      }
      if (!keepOpen && pending.length && (this.status.setupComplete || this.status.established || this.status.ready || skipped)) {
        this.view = 'incremental';
        this.incrementalSection = pending[0];
        this.el('setup-overlay').classList.remove('hidden');
        this.render();
        return;
      }
      if (!keepOpen && this.status.setupComplete && !this.status.ready) {
        this.resumeAt(5);
        this.setMessage('Scout setup needs attention before another scan can run.', 'error');
        return;
      }
      if (!keepOpen && (this.status.setupComplete || this.status.established || this.status.ready || skipped)) {
        this.view = 'closed';
        this.el('setup-overlay').classList.add('hidden');
        return;
      }
      this.view = 'onboarding';
      this.el('setup-overlay').classList.remove('hidden');
      this.render();
    } catch (error) {
      if (sequence !== this.refreshSequence) return;
      this.statusRetry = { keepOpen, context: retryContext };
      this.el('setup-overlay').classList.remove('hidden');
      this.el('setup-progress').innerHTML = '';
      this.el('setup-body').innerHTML = '<h2>Scout setup could not be loaded</h2><p>Check that the local Scout server is running, then retry.</p>';
      this.setMessage(error.message, 'error');
      this.el('setup-back').classList.add('hidden');
      this.el('setup-skip').classList.add('hidden');
      this.el('setup-next').classList.remove('hidden');
      this.el('setup-next').textContent = 'Retry';
    }
  },

  async retryStatus() {
    const retry = this.statusRetry;
    if (!retry) return;
    this.setBusy(true);
    try {
      await this.refreshStatus({ keepOpen: retry.keepOpen });
      if (this.statusRetry) return;
      if (retry.context.view !== 'closed') {
        this.view = retry.context.view;
        this.step = retry.context.step;
        this.preferenceStep = retry.context.preferenceStep;
        this.settingsSection = retry.context.settingsSection;
        this.incrementalSection = retry.context.incrementalSection;
        this.el('setup-overlay').classList.remove('hidden');
        this.render();
      }
      this.setMessage('Scout setup reconnected.', 'good');
    } finally {
      this.setBusy(false);
    }
  },

  async openSettings(section = null) {
    this.settingsOpen = true;
    this.view = section ? 'section' : 'hub';
    this.settingsSection = section;
    this.incrementalSection = null;
    this.preferenceStep = 0;
    this.preferenceDraft = null;
    this.retuneEntryStep = null;
    this.retuneSubtitle = null;
    // Provider checks can take several seconds. Open the dialog immediately so
    // the Settings button never appears unresponsive while status is refreshed.
    this.el('setup-overlay').classList.remove('hidden');
    this.el('setup-close').classList.remove('hidden');
    this.el('setup-title').textContent = 'Scout settings';
    this.el('setup-subtitle').textContent = 'Checking your private workspace…';
    this.el('setup-body').innerHTML = '<div class="setup-callout"><strong>Scout is checking your setup…</strong><p>This can take a few seconds while local AI providers are verified.</p></div>';
    await this.refreshStatus({ keepOpen: true });
  },

  async openBackupDetails() {
    this.settingsOpen = true;
    this.view = 'backup-details';
    this.settingsSection = null;
    this.incrementalSection = null;
    this.el('setup-overlay').classList.remove('hidden');
    this.el('setup-close').classList.remove('hidden');
    this.el('setup-title').textContent = 'Backup details';
    this.el('setup-subtitle').textContent = 'Checking the private backup status…';
    this.el('setup-body').innerHTML = '<div class="setup-callout"><strong>Scout is checking your backup…</strong></div>';
    await this.refreshStatus({ keepOpen: true });
  },

  closeSettings() {
    if (!DISMISSIBLE_VIEWS.has(this.view) || this.busy) return;
    // Invalidate any status request started for the view being closed. A slow
    // response must not reopen or replace a dialog after the user's intent.
    this.refreshSequence += 1;
    this.settingsOpen = false;
    this.view = 'closed';
    this.settingsSection = null;
    this.el('setup-close').classList.add('hidden');
    this.el('setup-overlay').classList.add('hidden');
  },

  async restartServer() {
    const activeOperation = Object.values(this.operations || {}).some((operation) => ['queued', 'running'].includes(operation?.status));
    if (window.Scout?.chat?.streaming || window.Scout?.scanRunning || activeOperation) {
      this.setMessage('Wait for the current Scout operation to finish before restarting.', 'error');
      return;
    }
    const remote = this.status?.requestAccess === 'remote-owner';
    if (remote && !confirm('Restart Scout on its host? Remote access will disconnect briefly, and the restart will proceed only after active work has finished.')) return;
    this.setBusy(true);
    this.setMessage('Restarting Scout…');
    try {
      const response = await fetch('/api/restart', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: remote }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Restart failed (${response.status})`);
    } catch (error) {
      // The accepted restart can close the connection before the small JSON
      // response reaches the browser. Continue with the bounded health poll.
      if (error?.name === 'TypeError') {
        this.setMessage('Scout is restarting…');
      } else {
        this.setBusy(false);
        this.setMessage(error.message || 'Scout could not start the restart.', 'error');
        return;
      }
    }
    const deadline = Date.now() + 20000;
    const poll = () => {
      fetch('/', { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error(); location.reload(); })
        .catch(() => {
          if (Date.now() > deadline) {
            this.setBusy(false);
            this.setMessage('Scout did not come back. Start it again with Scout.cmd.', 'error');
          } else {
            setTimeout(poll, 500);
          }
        });
    };
    setTimeout(poll, 1500);
  },

  setMessage(message = '', kind = '') {
    const el = this.el('setup-status');
    el.textContent = message;
    el.className = `setup-status ${kind}`.trim();
  },

  setBusy(busy) {
    this.busy = busy;
    this.el('setup-next').disabled = busy;
    this.el('setup-back').disabled = busy;
    this.el('setup-close').disabled = busy;
    for (const id of ['setup-run-scan', 'setup-schedule-save', 'setup-schedule-disable']) {
      const button = this.el(id); if (button) button.disabled = busy;
    }
  },

  async reattachOperations() {
    for (const type of ['proposal', 'scan']) {
      try {
        const body = await requestJson(`/api/operations?type=${type}`);
        this.operations[type] = body.operation || null;
        if (body.operation && ['queued', 'running'].includes(body.operation.status)) this.watchOperation(type, body.operation.id);
      } catch { /* older servers simply have no background-operation endpoint */ }
    }
  },

  operationPanelHtml(type) {
    const operation = this.operations[type];
    if (!operation) return '';
    const progress = operation.progress || { current: 0, total: 1 };
    const running = ['queued', 'running'].includes(operation.status);
    const terminal = operation.status === 'succeeded' ? 'Completed' : operation.status === 'failed' ? 'Needs attention' : 'In progress';
    return `<div class="setup-callout setup-operation" data-operation-id="${this.escape(operation.id)}" role="status">
      <strong>${this.escape(terminal)}: ${this.escape(operation.phase || type)}</strong>
      <progress max="${this.escape(progress.total || 1)}" value="${this.escape(progress.current || 0)}"></progress>
      <p class="meta">Step ${this.escape(progress.current || 0)} of ${this.escape(progress.total || 1)} · ${this.escape(operationElapsed(operation))}${running && operationRemaining(operation) ? ` · ${this.escape(operationRemaining(operation))}` : ''}</p>
      ${operation.error ? `<p class="bad">${this.escape(operation.error)}</p>` : ''}
      ${running ? '<p class="meta">You can close setup or this browser safely. Quitting Scout interrupts local work.</p>' : ''}
      ${type === 'proposal' && running ? '<p><button id="setup-continue-background" class="act" type="button">Continue in background</button></p>' : ''}
    </div>`;
  },

  watchOperation(type, id) {
    if (this.operationTimers[type]) clearTimeout(this.operationTimers[type]);
    const poll = async () => {
      try {
        const body = await requestJson(`/api/operations/${encodeURIComponent(id)}`);
        this.operations[type] = body.operation;
        const activeView = !this.el('setup-overlay').classList.contains('hidden');
        if (activeView && ((type === 'proposal' && this.step === 5) || (type === 'scan' && this.step === 6))) this.render();
        window.Scout?.showOperation?.(body.operation);
        if (['queued', 'running'].includes(body.operation.status)) {
          this.operationTimers[type] = setTimeout(poll, 1000);
          return;
        }
        delete this.operationTimers[type];
        const backgrounded = this.backgroundOperations.has(type);
        this.backgroundOperations.delete(type);
        await this.refreshStatus({ keepOpen: activeView && !backgrounded });
        if (backgrounded) {
          this.view = 'closed';
          this.el('setup-overlay').classList.add('hidden');
        }
        if (activeView && !backgrounded) this.render();
        if (body.operation.status === 'failed') this.setMessage(body.operation.error || `${type} failed`, 'error');
        else this.setMessage(type === 'proposal' ? 'Proposal ready. Review every staged file before activation.' : 'Scan completed. Review the keeper and discard summary.', 'good');
        if (type === 'scan') window.Scout?.loadOpportunities?.();
      } catch (error) {
        delete this.operationTimers[type];
        this.setMessage(error.message, 'error');
      }
    };
    this.operationTimers[type] = setTimeout(poll, 250);
  },

  continueOperationInBackground(type) {
    this.backgroundOperations.add(type);
    this.view = 'closed';
    this.el('setup-overlay').classList.add('hidden');
    window.Scout?.showOperation?.(this.operations[type]);
  },

  renderProgress() {
    this.el('setup-progress').innerHTML = STEPS.map((label, index) =>
      `<span class="${index <= this.step ? 'done' : ''}" title="${label}"></span>`).join('');
  },

  render() {
    this.setMessage();
    this.el('setup-actions').classList.remove('hidden');
    if (this.view === 'hub') return this.renderSettingsHub();
    if (this.view === 'section') return this.renderSettingsSection();
    if (this.view === 'backup-details') return this.renderBackupDetails();
    if (this.view === 'retune') {
      this.settingsOpen = true;
      this.el('setup-close').classList.remove('hidden');
      this.el('setup-title').textContent = 'Retune Scout';
      this.el('setup-subtitle').textContent = this.retuneSubtitle
        || 'Review staged changes before they affect your active search.';
    } else {
      this.settingsOpen = false;
      this.el('setup-close').classList.add('hidden');
    }
    this.el('setup-next').classList.remove('hidden');
    if (this.incrementalSection) return this.renderIncrementalSection();
    this.renderProgress();
    this.el('setup-back').classList.toggle('hidden', this.step === 0);
    this.el('setup-back').textContent = this.atRetuneEntry() ? 'Back to settings' : 'Back';
    // The optional hand-off uses the primary Finish for now action. Keep the
    // legacy footer control hidden so users are not offered duplicate exits.
    this.el('setup-skip').classList.add('hidden');
    const renderers = [
      this.renderWelcome,
      this.renderProviders,
      this.renderPreferences,
      this.renderAdzuna,
      this.renderImport,
      this.renderHandoff,
      this.renderFirstScan,
    ];
    renderers[this.step].call(this);
  },

  prepareDismissibleView({ title, subtitle, back = false }) {
    this.settingsOpen = true;
    this.el('setup-overlay').classList.remove('hidden');
    this.el('setup-close').classList.remove('hidden');
    this.el('setup-title').textContent = title;
    this.el('setup-subtitle').textContent = subtitle;
    this.el('setup-progress').innerHTML = '';
    this.el('setup-skip').classList.add('hidden');
    this.el('setup-next').classList.add('hidden');
    this.el('setup-back').classList.toggle('hidden', !back);
    this.el('setup-back').textContent = back ? 'Back to settings' : 'Back';
    this.el('setup-actions').classList.toggle('hidden', !back);
  },

  showSettingsHub() {
    this.view = 'hub';
    this.settingsSection = null;
    this.preferenceDraft = null;
    this.preferenceStep = 0;
    this.retuneEntryStep = null;
    this.retuneSubtitle = null;
    this.render();
    this.focusDialogTitle();
  },

  renderSettingsHub() {
    this.prepareDismissibleView({
      title: 'Scout settings',
      subtitle: 'Choose one area. Your existing workspace and history stay in place.',
    });
    this.el('setup-body').innerHTML = `
      <div class="settings-hub">
        ${SETTINGS_SECTIONS.map(([id, label, detail]) => `<button class="settings-card" type="button" data-settings-section="${id}"><strong>${label}</strong><span>${detail}</span></button>`).join('')}
      </div>`;
    this.el('setup-body').querySelectorAll('[data-settings-section]').forEach((button) => {
      button.addEventListener('click', () => {
        this.view = 'section';
        this.settingsSection = button.dataset.settingsSection;
        this.render();
        this.focusDialogTitle();
      });
    });
  },

  renderSettingsSection() {
    const section = this.settingsSection;
    const definition = SETTINGS_SECTIONS.find(([id]) => id === section) || SETTINGS_SECTIONS[0];
    this.prepareDismissibleView({ title: definition[1], subtitle: definition[2], back: true });
    if (section === 'search') return this.renderSearchSettings();
    if (section === 'providers') return this.renderProviderSettings();
    if (section === 'sources') return this.renderSourceSettings();
    if (section === 'scans') return this.renderScanSettings();
    if (section === 'backup') return this.renderBackupSettings();
    if (section === 'remote') return this.renderRemoteSettings();
    return this.renderAppSettings();
  },

  renderSearchSettings() {
    const config = this.status?.config || {};
    const search = config.search || {};
    this.el('setup-body').innerHTML = `
      <div class="setup-callout"><strong>${this.escape(config.profile?.displayName || 'Scout profile')}</strong>
      <p>Roles: ${this.escape((search.roleFamilies || []).join(', ') || 'Not configured')}</p>
      <p>Locations: ${this.escape((search.locations || []).join(', ') || 'Not configured')}</p>
      <p>Minimum salary: ${search.salaryMinimum == null ? 'Not set' : `${this.escape(config.currency || '')} ${this.escape(search.salaryMinimum)}`}</p>
      <p>Hard exclusions: ${this.escape((search.exclusions || []).join(', ') || 'None')}</p></div>
      ${searchProfileReviewHtml(this.searchProfile)}
      <p><button id="settings-retune-search" class="act primary" type="button">Retune my search</button></p>
      <p class="meta">Retuning stages evidence-led changes for review. It does not reset tracker, application, report or chat history.</p>`;
    this.el('settings-retune-search').addEventListener('click', () => {
      this.enterRetune('search');
      this.focusDialogTitle();
    });
    this.el('search-profile-save')?.addEventListener('click', () => this.saveSearchProfileDraft());
    this.el('search-profile-publish')?.addEventListener('click', () => this.publishSearchProfile());
    if (!this.searchProfile) void this.loadSearchProfileReview();
  },

  async loadSearchProfileReview() {
    try {
      this.searchProfile = await requestJson('/api/search-profile');
      if (this.view === 'section' && this.settingsSection === 'search') this.renderSearchSettings();
    } catch (error) {
      this.setMessage(error.message, 'error');
    }
  },

  async saveSearchProfileDraft() {
    try {
      const draft = JSON.parse(this.el('search-profile-draft').value);
      const result = await requestJson('/api/search-profile/draft', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft, revision: this.searchProfile?.draftRevision ?? null }),
      });
      this.searchProfile = { ...this.searchProfile, draft: result.draft, draftRevision: result.draftRevision };
      this.renderSearchSettings();
      this.setMessage('Complete search-profile draft saved for review.', 'good');
    } catch (error) {
      this.setMessage(error.message, 'error');
    }
  },

  async publishSearchProfile() {
    if (!this.el('search-profile-confirm')?.checked) {
      this.setMessage('Confirm that you reviewed the complete profile before publishing.', 'error');
      return;
    }
    try {
      const result = await requestJson('/api/search-profile/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: this.searchProfile?.draftRevision ?? null, confirmed: true }),
      });
      this.searchProfile = { ...this.searchProfile, published: result.published };
      this.renderSearchSettings();
      this.setMessage('Search profile published. New ranked discovery uses this version.', 'good');
    } catch (error) {
      this.setMessage(error.message, 'error');
    }
  },

  renderProviderSettings() {
    const models = this.status?.config?.ai?.models || {};
    this.el('setup-body').innerHTML = `
      <div class="setup-provider-list">${this.providerCard('codex')}${this.providerCard('claude')}</div>
      <div class="setup-callout"><strong>Models for individual job work</strong>
      <p>Choose an optional model for each provider when asking about a specific job, tailoring a CV or preparing for an interview. Leave blank to use that provider's default.</p>
      <div class="setup-grid">
        <label class="setup-field">Codex model<input id="setup-chat-model-codex" type="text" value="${this.escape(models.codex || '')}" placeholder="Provider default" pattern="[A-Za-z0-9._:\\-]+"></label>
        <label class="setup-field">Claude model<input id="setup-chat-model-claude" type="text" value="${this.escape(models.claude || '')}" placeholder="Provider default" pattern="[A-Za-z0-9._:\\-]+"></label>
      </div></div>
      <p><button id="settings-save-provider" class="act primary" type="button">Save AI settings</button>
      <button id="settings-refresh-providers" class="act" type="button">Refresh status</button></p>`;
    this.el('settings-save-provider').addEventListener('click', () => this.saveProviderSetting());
    this.el('settings-refresh-providers').addEventListener('click', () => this.refreshStatus({ keepOpen: true }));
  },

  async saveProviderSetting() {
    const provider = this.selectedProvider();
    if (!provider) return this.setMessage('Choose an installed, signed-in and compatible provider.', 'error');
    try {
      const models = {
        codex: this.el('setup-chat-model-codex').value.trim() || null,
        claude: this.el('setup-chat-model-claude').value.trim() || null,
      };
      const result = await requestJson('/api/setup/config', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ai: { provider, model: null, models } }),
      });
      this.status.config = result.config;
      window.Scout?.applyWorkspaceConfig?.(result.config);
      this.setMessage('AI provider and job-work models saved.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  renderSourceSettings() {
    this.el('setup-body').innerHTML = `
      <div class="setup-callout"><strong>Public sources</strong><p>Scout uses its configured public job sources without requiring credentials.</p></div>
      <div class="setup-callout"><strong>Adzuna: ${this.status?.adzunaConfigured ? 'configured' : 'not configured'}</strong>
      <p>Saved credentials are never displayed. Use Retune my search to add or replace them.</p></div>
      <p><button id="settings-retune-sources" class="act" type="button">Retune search and sources</button></p>`;
    this.el('settings-retune-sources').addEventListener('click', () => {
      this.enterRetune('sources');
      this.focusDialogTitle();
    });
  },

  renderScanSettings() {
    this.renderFirstScan({ includeBackup: false });
    this.el('setup-next').classList.add('hidden');
  },

  renderBackupSettings() {
    this.el('setup-body').innerHTML = this.backupPanelHtml();
    this.bindBackupPanel();
  },

  renderRemoteSettings() {
    this.el('setup-body').innerHTML = this.remoteAccessPanelHtml();
    this.bindRemoteAccessPanel();
  },

  renderAppSettings() {
    const device = this.status?.device;
    this.el('setup-body').innerHTML = device ? `
      <div class="setup-callout"><strong>Application updates</strong>
      <p>Notifications are on. Package downloads remain optional and are verified before installation.</p>
      <label class="setup-field"><span><input id="setup-auto-download-updates" type="checkbox" ${device.updates?.policy === 'download' ? 'checked' : ''}> Download verified update packages automatically</span></label>
      ${device.startupStatus?.supported ? `<label class="setup-field"><span><input id="setup-start-with-windows" type="checkbox" ${device.startWithWindows ? 'checked' : ''}> Start Scout when I sign into Windows</span></label>` : ''}
      <p><button id="setup-save-device" class="act primary" type="button">Save device settings</button></p></div>
      <p><button id="setup-restart" class="act" type="button">Restart Scout</button></p>` :
      '<p>Device settings are unavailable on this host.</p>';
    this.el('setup-save-device')?.addEventListener('click', () => this.saveDeviceSetting());
    this.el('setup-restart')?.addEventListener('click', () => this.restartServer());
  },

  renderBackupDetails() {
    this.prepareDismissibleView({
      title: 'Backup details',
      subtitle: 'Your work remains local even when the private backup needs attention.',
    });
    this.el('setup-body').innerHTML = `${this.backupPanelHtml()}
      <p><button id="backup-advanced-settings" class="act" type="button">Advanced backup settings</button></p>`;
    this.bindBackupPanel();
    this.el('backup-advanced-settings').addEventListener('click', () => {
      this.view = 'section';
      this.settingsSection = 'backup';
      this.render();
    });
  },

  renderWelcome() {
    const established = this.status?.established;
    const restored = this.restoredPreferences;
    const schedule = this.status?.schedule || {};
    const scheduleRuns = schedule.runs || [];
    const scheduleText = schedule.enabled
      ? `${scheduleRuns.map((run) => `${this.escape(run.provider)} ${this.escape(run.mode)} at ${this.escape(run.time)}`).join('; ')}; next run ${this.escape(formatLocalDateTime(schedule.nextRunAt, this.status?.config?.locale))}; last result ${this.escape(schedule.lastResult || 'unknown')}`
      : schedule.configured
        ? 'A daily scan is saved in the workspace, but this computer’s scheduler is not active.'
        : 'Daily scanning is off. Run one supervised scan before enabling it.';
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame setup-scout-welcome" role="img" aria-label="Scout welcomes you"></span></div><div class="scout-bubble tail-left">
      <h2>${established ? 'Review or retune Scout' : 'Hi, I’m Scout. Let’s find work that fits you.'}</h2>
      <p>${established ? 'Your existing tracker, profile, calibration and CV stay in place. Changes are staged for review; nothing is reset.' : 'I build your search from the CV and preferences you choose to share—not from unrelated AI chat history. Your search stays in your private workspace'} at <strong>${this.escape(this.status?.workspaceRoot || '')}</strong>.</p>
      <p class="meta">Scout ${this.escape(this.status?.appVersion || '')} · App: ${this.escape(this.status?.appRoot || '')}</p>
      <div class="setup-grid">
        <div class="setup-callout"><strong>No automatic sending</strong><p>Scout drafts material for your review. It never applies or sends outreach for you.</p></div>
        <div class="setup-callout"><strong>Local workspace</strong><p>Scout has no telemetry or hosted profile. Codex or Claude receives the career context needed for the task you ask it to perform, under that provider’s account terms.</p></div>
        <div class="setup-callout"><strong>Daily scan</strong><p>${scheduleText}</p></div>
        ${this.status?.device ? `<div class="setup-callout"><strong>Application updates</strong><p>Scout checks its official GitHub releases. Notifications are on; package downloads are optional and verified against the release SHA-256 manifest.</p><label class="setup-field"><span><input id="setup-auto-download-updates" type="checkbox" ${this.status.device.updates?.policy === 'download' ? 'checked' : ''}> Download verified update packages automatically</span></label>${this.status.device.startupStatus?.supported ? `<label class="setup-field"><span><input id="setup-start-with-windows" type="checkbox" ${this.status.device.startWithWindows ? 'checked' : ''}> Start Scout when I sign into Windows</span></label>` : ''}<p><button id="setup-save-device" class="act" type="button">Save device settings</button></p><p class="meta">Installation always asks first. Updates never replace your separate workspace, provider sign-ins or Tailscale Serve mapping.</p></div>` : ''}
      </div>
      ${this.remoteAccessPanelHtml()}
      ${restored ? `<div class="setup-callout"><strong>Choose settings for this computer</strong><p>Your work has been restored. Device integrations stay off until you confirm them here.</p>${this.status?.device && restored.startWithWindows ? '<label class="setup-field"><span><input id="restore-start-with-windows" type="checkbox"> Start Scout with Windows on this computer</span></label>' : ''}${this.status?.schedule?.configured ? `<label class="setup-field"><span><input id="restore-daily-schedule" type="checkbox"> Enable the saved ${this.escape(this.status.schedule.time || '')} daily scan on this computer</span></label>` : ''}<p><button id="restore-apply-device" class="act primary" type="button">Apply selected settings</button> <button id="restore-keep-device-local" class="act" type="button">Keep them off</button></p></div>` : ''}
      <p>You can move or back up the workspace independently. API credentials stay in its ignored <code>.env</code> file and are never shown again here.</p>
      <p class="meta">Something stuck? <button id="setup-restart" class="act" type="button">Restart Scout</button> restarts the local server and reloads this page.</p></div></div>
      ${established ? this.backupPanelHtml() : ''}`;
    this.el('setup-restart').addEventListener('click', () => this.restartServer());
    this.el('setup-save-device')?.addEventListener('click', () => this.saveDeviceSetting());
    this.bindRemoteAccessPanel();
    this.el('restore-apply-device')?.addEventListener('click', () => this.applyRestoredPreferences());
    this.el('restore-keep-device-local')?.addEventListener('click', () => { this.restoredPreferences = null; this.render(); this.setMessage('Device integrations remain off. You can enable them later in Settings.', 'good'); });
    if (established) this.bindBackupPanel();
    this.el('setup-next').textContent = established ? 'Review settings' : 'Start setup';
  },

  renderIncrementalSection() {
    this.el('setup-title').textContent = 'Scout setup update';
    this.el('setup-subtitle').textContent = 'Only this new setting needs your attention.';
    this.el('setup-progress').innerHTML = '<span class="done" title="Windows startup"></span>';
    this.el('setup-back').classList.add('hidden');
    this.el('setup-skip').classList.remove('hidden');
    this.el('setup-skip').textContent = 'Later';
    this.el('setup-next').textContent = 'Save setting';
    this.el('setup-body').innerHTML = `<div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout has a new setting"></span></div><div class="scout-bubble tail-left"><h2>Should I start with Windows?</h2><p>This keeps Scout available in the notification-area arrow after you sign in. You can change it later in Settings.</p><label class="setup-field"><span><input id="setup-start-with-windows" type="checkbox" ${this.status?.device?.startWithWindows ? 'checked' : ''}> Start Scout when I sign into Windows</span></label></div></div>`;
  },

  async saveDeviceSetting() {
    const body = { updatePolicy: this.el('setup-auto-download-updates')?.checked ? 'download' : 'notify' };
    if (this.el('setup-start-with-windows')) body.startWithWindows = Boolean(this.el('setup-start-with-windows').checked);
    const result = await requestJson('/api/device/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    this.status.device = result.settings;
    this.setMessage('Device update settings saved.', 'good');
  },

  remoteAccessPanelHtml() {
    const remote = this.status?.remoteAccess || { state: 'disabled' };
    const local = this.status?.requestAccess !== 'remote-owner';
    if (remote.enabled && remote.origin) {
      return `<section class="setup-callout"><strong>Private Remote Access: on</strong><p>Only <strong>${this.escape(remote.ownerLogin || 'the configured owner')}</strong> can open Scout through Tailscale.</p><p><a href="${this.escape(remote.origin)}" target="_blank" rel="noreferrer">${this.escape(remote.origin)}</a></p><p>On your phone or laptop, install and sign in to Tailscale with that same login, open this address, then use your browser's <strong>Add to Home Screen</strong> or <strong>Install app</strong> action.</p><p class="meta">The host computer must be awake and signed in. Scout remains bound to this computer only; this is not a public internet address.</p>${local ? '<p><button id="setup-copy-remote-url" class="act" type="button">Copy address</button> <button id="setup-disable-remote" class="act" type="button">Turn off remote access</button></p>' : '<p class="meta">Remote hosting settings can only be changed on the Scout host computer.</p>'}</section>`;
    }
    if (!local) {
      return `<section class="setup-callout"><strong>Private Remote Access: ${this.escape(remote.state || 'off')}</strong><p>Finish setup on the Scout host computer.</p></section>`;
    }
    if (!remote.installed) {
      return `<section class="setup-callout"><strong>Private Remote Access (optional)</strong><p>Use this Scout workspace and its chats from your phone and laptop without exposing Scout to the public internet.</p><p><a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Install Tailscale from its official site</a>, sign in, then return here.</p><p><button id="setup-refresh-remote" class="act" type="button">Check again</button></p></section>`;
    }
    if (remote.state === 'setup-required') {
      return `<section class="setup-callout"><strong>Private Remote Access needs setup</strong><p>${this.escape(remote.blocker || 'Sign in to Tailscale on this computer.')}</p><p><button id="setup-refresh-remote" class="act" type="button">Check again</button></p></section>`;
    }
    const authorization = remote.state === 'authorizing' && remote.authorizationUrl
      ? `<p><a href="${this.escape(remote.authorizationUrl)}" target="_blank" rel="noreferrer">Authorize HTTPS in Tailscale</a>, then retry the same setup.</p>` : '';
    const portHelp = remote.customPortRequired
      ? '<p class="meta">HTTPS ports 443 and 8443 already have Serve mappings. Enter a different free port; Scout will not alter those mappings.</p>'
      : `<p class="meta">Scout will use HTTPS port ${this.escape(remote.suggestedPort || 443)} unless you choose another free port.</p>`;
    return `<section class="setup-callout"><strong>Private Remote Access (optional)</strong><p>Tailscale detected ${remote.ownerLogin ? `the signed-in owner <strong>${this.escape(remote.ownerLogin)}</strong>` : 'a signed-in account'}. Only this exact login will be accepted.</p>${remote.blocker ? `<p>${this.escape(remote.blocker)}</p>` : ''}${authorization}${portHelp}<label class="setup-field">HTTPS port (leave blank for automatic)<input id="setup-remote-port" type="number" min="1" max="65535" placeholder="${this.escape(remote.suggestedPort || '')}"></label>${this.status?.device ? '<label class="setup-field"><span><input id="setup-remote-startup" type="checkbox" checked> Start Scout automatically with Windows</span></label>' : ''}<label class="setup-field"><span><input id="setup-remote-confirm" type="checkbox"> I confirm only the detected Tailscale owner should have access</span></label><p><button id="setup-enable-remote" class="act primary" type="button">${remote.state === 'authorizing' ? 'Retry setup' : 'Enable private remote access'}</button> <button id="setup-refresh-remote" class="act" type="button">Check again</button></p><p class="meta">Scout inspects existing Tailscale Serve settings first and manages only its own mapping. It never enables Funnel, LAN access or router forwarding.</p></section>`;
  },

  bindRemoteAccessPanel() {
    this.el('setup-refresh-remote')?.addEventListener('click', () => this.refreshRemoteAccess());
    this.el('setup-enable-remote')?.addEventListener('click', () => this.enableRemoteAccess());
    this.el('setup-disable-remote')?.addEventListener('click', () => this.disableRemoteAccess());
    this.el('setup-copy-remote-url')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(this.status?.remoteAccess?.origin || '');
      this.setMessage('Remote address copied.', 'good');
    });
  },

  async refreshRemoteAccess() {
    this.setMessage('Checking Tailscale and existing Serve mappings...');
    try {
      this.status.remoteAccess = await requestJson('/api/remote-access/status');
      this.render();
      this.setMessage('Remote access status refreshed.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async enableRemoteAccess() {
    if (!this.el('setup-remote-confirm')?.checked) return this.setMessage('Confirm the detected owner before enabling remote access.', 'error');
    const port = fieldValue('setup-remote-port').trim();
    this.setMessage('Configuring Scout\'s private Tailscale address...');
    try {
      const result = await requestJson('/api/remote-access/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ httpsPort: port || null, confirmOwner: true, startWithWindows: this.el('setup-remote-startup')?.checked !== false }),
      });
      this.status.remoteAccess = result;
      if (result.state !== 'authorizing') await this.refreshStatus({ keepOpen: true });
      this.render();
      this.setMessage(result.state === 'authorizing' ? 'Approve HTTPS with Tailscale, then select Retry setup.' : result.startupWarning || 'Private remote access is ready.', result.startupWarning ? 'warning' : 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async disableRemoteAccess() {
    if (!confirm('Turn off Scout private remote access? Local use will continue.')) return;
    try {
      await requestJson('/api/remote-access/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await this.refreshStatus({ keepOpen: true });
      this.render();
      this.setMessage('Private remote access is off. Unrelated Tailscale mappings were left unchanged.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  providerCard(name) {
    const provider = this.status?.providers?.[name] || {};
    const selected = (this.status?.config?.ai?.provider || '') === name;
    const compatible = Boolean(provider.authenticated && provider.capabilities?.structuredOutput !== false);
    const state = !provider.installed ? 'Not installed'
      : !provider.authenticated ? 'Installed; sign-in required'
        : compatible ? 'Installed, signed in and compatible' : 'Installed and signed in; CLI update required';
    const login = name === 'codex' ? 'codex' : 'claude auth login';
    const guide = name === 'codex' ? 'https://developers.openai.com/codex/cli/' : 'https://docs.anthropic.com/en/docs/claude-code/setup';
    const platform = this.status?.platform === 'win32' ? 'Windows PowerShell'
      : this.status?.platform === 'darwin' ? 'Terminal on macOS' : 'your Linux terminal';
    return `<label class="setup-provider ${compatible ? 'available' : ''}">
      <input type="radio" name="setup-provider" value="${name}" ${selected ? 'checked' : ''} ${compatible ? '' : 'disabled'}>
      <strong>${name[0].toUpperCase() + name.slice(1)}</strong>
      <span class="meta">${state}</span>
      ${compatible ? '' : provider.authenticated
        ? `<span class="meta">Update this CLI from its <a href="${guide}" target="_blank" rel="noreferrer">official installation guide</a>, then refresh. Scout requires schema-constrained output for bounded workflows.</span>`
        : `<span class="meta"><a href="${guide}" target="_blank" rel="noreferrer">Official installation guide for macOS, Linux and Windows</a>. Install the standalone or user-local CLI, open ${platform}, run <code>${login}</code>, complete its official CLI login flow, then refresh. Scout needs an authenticated command-line provider; a desktop-app login alone is not enough. Your provider account may have separate usage limits or costs.</span>`}
    </label>`;
  },

  renderProviders() {
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is ready"></span></div><div class="scout-bubble tail-left">
      <h2>Choose an AI provider</h2>
      <p>Scout uses the provider's official CLI and account login. Scout does not ask for or store an AI password or API key.</p>
      <div class="setup-provider-list">${this.providerCard('codex')}${this.providerCard('claude')}</div>
      <button id="setup-provider-refresh" class="act" type="button">Refresh provider status</button>
      <p class="meta">One signed-in provider is required. A second provider is optional and can later perform a verification pass.</p></div></div>`;
    this.el('setup-provider-refresh').addEventListener('click', async () => {
      this.setBusy(true);
      this.setMessage('Checking providers…');
      await this.refreshStatus({ keepOpen: true });
      this.setBusy(false);
    });
    this.el('setup-next').textContent = 'Continue';
  },

  renderPreferences() {
    const c = this.status?.config || {};
    if (!this.preferenceDraft) this.preferenceDraft = {
      displayName: c.profile?.displayName || '', tone: c.profile?.tone || '',
      roleFamilies: (c.search?.roleFamilies || []).join(', '), sectors: (c.search?.sectors || []).join(', '),
      locations: (c.search?.locations || []).join(', '), exclusions: (c.search?.exclusions || []).join(', '),
      salaryMinimum: c.search?.salaryMinimum ?? '', currency: c.currency || 'GBP', locale: c.locale || 'en-GB', timezone: c.timezone || 'Europe/London',
      commuteOrigin: c.commute?.origin || '', commuteMode: c.commute?.mode || 'either', commuteMax: c.commute?.maxMinutes ?? 180,
      includeUnknown: c.commute?.includeUnknown !== false,
    };
    const d = this.preferenceDraft;
    const option = (value, label) => `<option value="${value}" ${d.commuteMode === value ? 'selected' : ''}>${label}</option>`;
    const questions = [
      ['First, what should I call you?', 'I’ll also match the tone you want in CVs and outreach drafts.', `<label class="setup-field">Your name<input id="setup-name" autocomplete="name" value="${this.escape(d.displayName)}" required></label><label class="setup-field">Writing tone<input id="setup-tone" value="${this.escape(d.tone)}" placeholder="Natural, direct and evidence-led"></label>`],
      ['What kind of work should I look for?', 'Use job titles or role families you would genuinely consider. These answers become search queries after you approve the setup.', `<label class="setup-field wide">Role families <span>comma-separated</span><input id="setup-roles" value="${this.escape(d.roleFamilies)}" placeholder="Software engineer, product manager, data analyst"></label><label class="setup-field wide">Sectors <span>comma-separated</span><input id="setup-sectors" value="${this.escape(d.sectors)}" placeholder="Developer tools, climate, healthcare"></label>`],
      ['Where can the right role be?', 'I use travel time rather than simple mileage when commute information is available.', `<label class="setup-field wide">Locations <span>comma-separated</span><input id="setup-locations" value="${this.escape(d.locations)}"></label><label class="setup-field wide">Commute origin<input id="setup-commute-origin" value="${this.escape(d.commuteOrigin)}" placeholder="Town, city or postcode"></label><label class="setup-field">Mode<select id="setup-commute-mode">${option('either','Car or public transport')}${option('car','Car')}${option('public','Public transport')}${option('any','No filter')}</select></label><label class="setup-field">Maximum minutes<input id="setup-commute-max" type="number" min="0" max="1440" value="${this.escape(d.commuteMax)}"></label><label class="setup-field wide"><span><input id="setup-include-unknown" type="checkbox" ${d.includeUnknown ? 'checked' : ''}> Include roles with unknown commute</span></label>`],
      ['What compensation makes a move worthwhile?', 'This guides the search; it is not inserted into applications.', `<label class="setup-field">Minimum base salary<input id="setup-salary" type="number" min="0" step="1000" value="${this.escape(d.salaryMinimum)}"></label><label class="setup-field">Currency<input id="setup-currency" maxlength="3" value="${this.escape(d.currency)}"></label>`],
      ['What should I rule out immediately?', 'Keep these to genuine dealbreakers so I don’t hide an unusual but excellent role.', `<label class="setup-field wide">Hard exclusions <span>comma-separated</span><textarea id="setup-exclusions">${this.escape(d.exclusions)}</textarea></label>`],
    ];
    const q = questions[this.preferenceStep];
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is asking a question"></span></div><div class="scout-bubble tail-left"><div class="meta">Question ${this.preferenceStep + 1} of ${questions.length}</div><h2>${q[0]}</h2><p>${q[1]}</p><div class="setup-grid">${q[2]}</div></div></div>`;
    this.el('setup-next').textContent = this.preferenceStep === questions.length - 1 ? 'Save my answers' : 'Answer';
  },

  capturePreferenceQuestion() {
    const d = this.preferenceDraft;
    const value = (id, key) => { const el = this.el(id); if (el) d[key] = el.value; };
    [['setup-name','displayName'],['setup-tone','tone'],['setup-roles','roleFamilies'],['setup-sectors','sectors'],['setup-locations','locations'],['setup-commute-origin','commuteOrigin'],['setup-commute-mode','commuteMode'],['setup-commute-max','commuteMax'],['setup-salary','salaryMinimum'],['setup-currency','currency'],['setup-exclusions','exclusions']].forEach(([id,key]) => value(id,key));
    const unknown = this.el('setup-include-unknown'); if (unknown) d.includeUnknown = unknown.checked;
  },

  renderAdzuna() {
    this.el('setup-body').innerHTML = `
      <h2>Add Adzuna search (optional)</h2>
      <p>Register for an Adzuna developer account, then paste the application ID and API key below. Scout saves them only to the private workspace's ignored <code>.env</code> file.</p>
      ${this.status?.adzunaConfigured ? '<div class="setup-callout"><strong>Adzuna is configured</strong><p>The saved values are deliberately not displayed. Leave both fields empty to keep them unchanged.</p></div>' : ''}
      <div class="setup-grid">
        <label class="setup-field">Application ID<input id="setup-adzuna-id" type="password" autocomplete="off" spellcheck="false"></label>
        <label class="setup-field">API key<input id="setup-adzuna-key" type="password" autocomplete="off" spellcheck="false"></label>
      </div>
      <p class="meta">You can skip this and use Scout's public sources. Add credentials later by returning to setup or editing the workspace's local environment file.</p>`;
    this.el('setup-next').textContent = 'Continue';
  },

  renderImport() {
    const imported = this.imported;
    this.el('setup-body').innerHTML = `
      <h2>Import your existing CV (optional)</h2>
      <p>Scout accepts PDF, DOCX, Markdown and plain text up to 10 MB. Text extraction happens locally. Scanned PDFs need OCR before they can be used.</p>
      <label class="setup-field"><span>CV file</span><input id="setup-cv-file" type="file" accept=".pdf,.docx,.md,.markdown,.txt"></label>
      ${imported ? `<h3>Extracted preview</h3><div id="setup-cv-preview" class="setup-preview"></div><p class="meta">Saved locally as ${this.escape(imported.extracted)}</p>` : ''}`;
    if (imported) this.el('setup-cv-preview').textContent = imported.text || '';
    this.el('setup-next').textContent = imported ? 'Continue' : 'Import or skip';
  },

  renderHandoff() {
    const action = handoffAction(this.status?.ready);
    const operation = this.operations.proposal;
    const generating = operation && ['queued', 'running'].includes(operation.status);
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is ready to talk"></span></div><div class="scout-bubble tail-left">
      <h2>Generate your evidence-led CV and search proposal</h2>
      <p>Scout will use the answers and evidence you supplied to propose a CV, profile, scoring calibration and search lanes. Activation is required before the first scan.</p>
      <p><button id="setup-generate-proposal" class="act primary" type="button" ${generating ? 'disabled' : ''}>${this.proposal ? 'Regenerate proposal' : 'Generate proposal'}</button></p>
      <p class="meta">Scout sends only your bounded setup answers and imported CV evidence. It stages validated changes for review and never activates them automatically.</p>
      ${this.operationPanelHtml('proposal')}
      ${this.proposal ? `<div class="setup-callout"><strong>Proposal ready to review</strong><p>${this.escape(this.proposal.summary || '')}</p>${(this.proposal.unresolvedQuestions || []).length ? `<p class="bad">Resolve first: ${this.escape(this.proposal.unresolvedQuestions.join('; '))}</p>` : ''}<details open><summary>Review staged files</summary>${(this.proposal.files || []).map((file) => `<h3>${this.escape(file.path)}</h3><pre class="setup-preview">${this.escape(file.staged)}</pre>`).join('')}</details><label class="setup-field"><span><input id="setup-reviewed-proposal" type="checkbox"> I reviewed all five staged files</span></label><p><button id="setup-activate-proposal" class="act primary" type="button" disabled>Approve and activate</button> <button id="setup-discard-proposal" class="act" type="button">Discard</button></p></div>` : ''}
      </div></div>
      <div class="setup-callout"><strong>${this.status?.ready ? 'Proposal activated' : 'Review and activation required'}</strong><p>${this.status?.ready ? 'Your approved evidence and settings are ready for a supervised first scan.' : 'Generate a complete proposal, review all five files and activate them before continuing.'}</p>${this.status?.recovery?.available ? '<p><button id="setup-recover-master-cv" class="act primary" type="button">Restore reviewed master CV</button></p>' : ''}</div>`;
    this.el('setup-generate-proposal').addEventListener('click', () => this.generateProposal());
    this.el('setup-continue-background')?.addEventListener('click', () => this.continueOperationInBackground('proposal'));
    this.el('setup-reviewed-proposal')?.addEventListener('change', (event) => {
      this.el('setup-activate-proposal').disabled = !event.target.checked || Boolean((this.proposal.unresolvedQuestions || []).length);
    });
    this.el('setup-activate-proposal')?.addEventListener('click', () => this.activateProposal());
    this.el('setup-discard-proposal')?.addEventListener('click', () => this.discardProposal());
    this.el('setup-recover-master-cv')?.addEventListener('click', () => this.recoverMasterCv());
    this.el('setup-next').textContent = action.label;
  },

  renderFirstScan({ includeBackup = true } = {}) {
    const health = this.status?.scanHealth || {};
    const schedule = this.status?.schedule || {};
    const healthy = Boolean(health.lastRunAt && health.healthy);
    const configuredJobs = (this.status?.config?.schedule?.jobs || []).some((job) => job.enabled !== false);
    const hasHistory = Boolean(health.lastRunAt) || configuredJobs;
    const provider = this.status?.config?.ai?.provider;
    const primaryId = `${provider}-primary`;
    const primaryRun = (schedule.runs || []).find((run) => run.id === primaryId);
    const operation = this.operations.scan;
    const scanning = operation && ['queued', 'running'].includes(operation.status);
    const outcome = health.lastRunAt ? scanOutcomeSummary(health) : null;
    const other = ['codex', 'claude'].find((name) => name !== provider
      && this.status?.providers?.[name]?.authenticated
      && this.status?.providers?.[name]?.capabilities?.structuredOutput !== false);
    const secondRun = (schedule.runs || []).find((run) => run.mode === 'second-pass');
    const showSecond = this.view === 'section' && (this.showVerificationPass || secondRun);
    const scheduleRow = (id, name, mode, run, defaultTime) => {
      const days = run?.days?.length ? run.days : EVERY_DAY;
      const preset = matchingPreset(days, mode);
      return `<div class="setup-schedule-row" data-schedule-row="${this.escape(id)}" data-schedule-mode="${this.escape(mode)}">
      <label class="setup-field">${this.escape(name[0].toUpperCase() + name.slice(1))} ${mode === 'primary' ? 'scan' : 'verification pass'} time<input data-schedule-time type="time" value="${this.escape(run?.time || defaultTime)}"></label>
      <label class="setup-field">Days<select data-schedule-preset>${DAY_PRESETS.map(([value, label]) => `<option value="${value}" ${preset === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <fieldset class="setup-schedule-days" data-schedule-days ${preset === 'custom' ? '' : 'hidden'}><legend>Days this job runs</legend>${DAY_LABELS.map((label, day) => `<label><input type="checkbox" data-schedule-day="${day}" ${days.includes(day) ? 'checked' : ''}> ${label}</label>`).join('')}</fieldset>
      <label class="setup-field">Scan model <span>Optional; used for this scan job. Blank uses the provider default</span><input data-schedule-model type="text" value="${this.escape(run?.model || '')}" placeholder="Provider default" pattern="[A-Za-z0-9._:\\-]+"></label>
      <p><button class="act" data-schedule-enable="${this.escape(id)}" data-provider="${this.escape(name)}" data-mode="${this.escape(mode)}" type="button" ${(healthy || run?.configured) ? '' : 'disabled'}>${run?.configured ? 'Save scan settings' : `Enable ${name} ${mode === 'primary' ? 'scan' : 'verification pass'}`}</button>${run?.configured ? ` <button class="act" data-schedule-disable="${this.escape(id)}" type="button">Disable</button>` : ''}</p>
      ${run?.configured ? `<p class="meta">Currently runs: ${this.escape(run.daysLabel || 'Every day')} at ${this.escape(run.time || defaultTime)}.</p>` : ''}
    </div>`;
    };
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame" role="img" aria-label="Scout is ready to search"></span></div><div class="scout-bubble tail-left">
      <h2>${hasHistory ? 'Your first scan is ready to review' : 'Run your first search with me'}</h2>
      <p>I search using your approved role families and search lanes, then apply your locations, exclusions, compensation preferences and evidence-based scoring. I do not use unrelated AI conversations.</p>
      <div class="setup-callout"><strong>${hasHistory ? 'Supervised scan completed' : 'Supervised first scan'}</strong><p>${healthy ? `Last run: ${this.escape(formatLocalDateTime(health.lastRunAt, this.status?.config?.locale))}.` : 'A full source check can take several minutes and no application will be sent.'}</p>${outcome ? `<p><strong>${this.escape(outcome.headline)}</strong>${outcome.breakdown.length ? ` — ${this.escape(outcome.breakdown.join(', '))}` : ''}. Zero keepers can be a valid strict result.</p><p><a href="#reports" data-report-date="${this.escape(String(health.lastRunAt).slice(0, 10))}">Review the dated scan report</a></p>` : ''}</div>
      ${this.operationPanelHtml('scan')}
      <p><button id="setup-run-scan" class="act primary" type="button" ${scanning ? 'disabled' : ''}>${scanning ? 'Scan running…' : hasHistory ? 'Scan now' : 'Run first scan now'}</button></p>
      <div class="setup-callout"><strong>Daily scan schedule</strong><p>Each provider job is independent. First-run setup only offers your selected provider.</p>
      ${scheduleRow(primaryId, provider, 'primary', primaryRun, '07:30')}
      ${this.view === 'section' && other && !showSecond ? '<p><button id="setup-add-verification" class="act" type="button">Add verification pass</button></p>' : ''}
      ${showSecond ? scheduleRow(secondRun?.id || `${other}-second-pass`, secondRun?.provider || other, 'second-pass', secondRun, '08:30') : ''}
      </div></div>
      ${includeBackup ? this.backupPanelHtml() : ''}`;
    this.el('setup-run-scan').addEventListener('click', () => this.runSupervisedScan());
    this.el('setup-add-verification')?.addEventListener('click', () => { this.showVerificationPass = true; this.renderFirstScan({ includeBackup }); });
    // A preset ticks the day boxes it stands for; editing the boxes directly
    // switches the preset to Custom so the two controls never disagree.
    this.el('setup-body').querySelectorAll('[data-schedule-preset]').forEach((select) => select.addEventListener('change', () => {
      const row = select.closest('[data-schedule-row]');
      const group = row.querySelector('[data-schedule-days]');
      if (select.value === 'custom') { group.hidden = false; return; }
      const days = presetDays(select.value, row.dataset.scheduleMode);
      row.querySelectorAll('[data-schedule-day]').forEach((box) => { box.checked = days.includes(Number(box.dataset.scheduleDay)); });
      group.hidden = true;
    }));
    this.el('setup-body').querySelectorAll('[data-schedule-day]').forEach((box) => box.addEventListener('change', () => {
      const row = box.closest('[data-schedule-row]');
      row.querySelector('[data-schedule-preset]').value = matchingPreset(this.selectedScheduleDays(row), row.dataset.scheduleMode);
    }));
    this.el('setup-body').querySelectorAll('[data-schedule-enable]').forEach((button) => button.addEventListener('click', () => {
      const row = button.closest('[data-schedule-row]');
      const days = this.selectedScheduleDays(row);
      if (!days.length) return this.setMessage('Choose at least one day for this scan job.', 'error');
      this.saveSchedule({
        id: button.dataset.scheduleEnable, provider: button.dataset.provider, mode: button.dataset.mode,
        time: row.querySelector('[data-schedule-time]').value, days,
        model: row.querySelector('[data-schedule-model]').value.trim() || null,
      });
    }));
    this.el('setup-body').querySelectorAll('[data-schedule-disable]').forEach((button) => button.addEventListener('click', () => this.disableSchedule(button.dataset.scheduleDisable)));
    this.el('setup-body').querySelector('[data-report-date]')?.addEventListener('click', (event) => { event.preventDefault(); window.Scout?.openReport?.(event.currentTarget.dataset.reportDate); });
    if (includeBackup) this.bindBackupPanel();
    this.el('setup-next').textContent = scanning ? 'Finish setup — scan continues' : 'Finish';
  },

  async runSupervisedScan() {
    this.setMessage('Starting the supervised scan…');
    try {
      const provider = this.status?.config?.ai?.provider;
      const model = this.el('setup-body').querySelector(`[data-schedule-row="${provider}-primary"] [data-schedule-model]`)?.value.trim() || null;
      const result = await requestJson('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, model }) });
      this.operations.scan = result.operation;
      this.render();
      this.watchOperation('scan', result.operation.id);
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  renderBootstrap() {
    const git = this.status?.git || {};
    this.el('setup-title').textContent = 'Welcome to Scout';
    this.el('setup-subtitle').textContent = 'Start locally or restore your private workspace.';
    this.el('setup-progress').innerHTML = '';
    this.el('setup-back').classList.add('hidden');
    this.el('setup-next').classList.add('hidden');
    this.el('setup-skip').classList.add('hidden');
    this.el('setup-body').innerHTML = `
      <div class="setup-conversation"><div class="setup-scout"><span class="setup-scout-frame setup-scout-welcome" role="img" aria-label="Scout welcomes you"></span></div><div class="scout-bubble tail-left">
      <h2>How would you like to begin?</h2>
      <p>Scout stores your CV, job tracker and chats in a private folder on this computer. Online backup is optional; Scout works fully without GitHub.</p>
      <div class="setup-grid">
        <div class="setup-callout"><strong>Set up Scout for the first time</strong><p>Create a new local workspace. You can add private backup at the end or later in Settings.</p><button id="setup-create-workspace" class="act primary" type="button">Create my local workspace</button></div>
        <div class="setup-callout"><strong>Restore my existing workspace</strong><p>Use a private GitHub repository made by Scout backup. Tracked career files remain readable in that private repository; credentials, generated documents and chat transcripts are encrypted.</p><button id="setup-show-restore" class="act" type="button">Restore existing workspace</button></div>
      </div>
      <div id="setup-restore-form" class="setup-callout hidden">
        <strong>Restore from private GitHub</strong>
        <p>${git.installed && git.credentialManager ? 'Git and Git Credential Manager are ready. GitHub will open its normal browser sign-in if needed.' : 'Install Git for Windows with Git Credential Manager, then return here and check again.'}</p>
        ${git.installed && git.credentialManager ? '' : '<p><a href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">Install Git for Windows</a> <button id="setup-check-git" class="act" type="button">Check again</button></p>'}
        <label class="setup-field">Private repository HTTPS URL<input id="setup-restore-url" type="url" placeholder="https://github.com/your-name/scout-workspace"></label>
        <label class="setup-field">Recovery passphrase or recovery key<input id="setup-restore-secret" type="password" autocomplete="off"></label>
        <p><button id="setup-restore-workspace" class="act primary" type="button" ${git.installed && git.credentialManager ? '' : 'disabled'}>Restore securely</button> <button id="setup-cancel-restore" class="act" type="button">Cancel</button></p>
        <p class="meta">Restore requires an empty Scout workspace folder and never overwrites existing work.</p>
      </div></div></div>`;
    this.el('setup-create-workspace').addEventListener('click', () => this.createWorkspace());
    // Revealing the restore form must be reversible; without a Cancel the two
    // first-run choices become a one-way door into a credentials form.
    this.el('setup-show-restore').addEventListener('click', () => {
      this.el('setup-restore-form').classList.remove('hidden');
      this.el('setup-show-restore').disabled = true;
    });
    this.el('setup-cancel-restore')?.addEventListener('click', () => {
      this.el('setup-restore-form').classList.add('hidden');
      this.el('setup-show-restore').disabled = false;
      this.el('setup-restore-url').value = '';
      this.el('setup-restore-secret').value = '';
      this.setMessage();
    });
    this.el('setup-check-git')?.addEventListener('click', () => location.reload());
    this.el('setup-restore-workspace')?.addEventListener('click', () => this.restoreWorkspace());
  },

  // Creating the workspace is fast, but the status refresh behind it probes
  // providers and Git and can take several seconds. Lock the two bootstrap
  // choices and move to the first real step from the create response, so the
  // welcome screen never sits unchanged under a frozen progress message while
  // a second click returns "this workspace already exists".
  setBootstrapChoicesBusy(busy) {
    for (const id of ['setup-create-workspace', 'setup-show-restore', 'setup-restore-workspace', 'setup-cancel-restore']) {
      const button = this.el(id);
      if (button) button.disabled = busy;
    }
    // Re-enabling must not undo the open/closed state of the restore form.
    const showRestore = this.el('setup-show-restore');
    if (!busy && showRestore) {
      showRestore.disabled = !this.el('setup-restore-form')?.classList.contains('hidden');
    }
  },

  async createWorkspace() {
    this.setBootstrapChoicesBusy(true);
    this.setMessage('Creating your local private workspace…');
    try {
      await requestJson('/api/workspace/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      this.status = { ...this.status, bootstrap: false, trackerExists: true };
      this.view = 'onboarding';
      this.step = 0;
      this.el('setup-next').classList.remove('hidden');
      this.render();
      this.setMessage('Your local workspace is ready. Continue to choose an AI provider.', 'good');
      void this.refreshStatus({ keepOpen: true });
    } catch (error) {
      this.setBootstrapChoicesBusy(false);
      this.setMessage(error.message, 'error');
    }
  },

  async restoreWorkspace() {
    const remoteUrl = fieldValue('setup-restore-url').trim();
    const secret = fieldValue('setup-restore-secret').trim();
    if (!remoteUrl || !secret) return this.setMessage('Enter the private repository URL and a recovery secret.', 'error');
    this.setMessage('Signing in, validating and restoring your private workspace…');
    try {
      const result = await requestJson('/api/workspace/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remoteUrl, secret }),
      });
      this.restoredPreferences = result.devicePreferences || {};
      this.el('setup-next').classList.remove('hidden');
      await this.refreshStatus({ keepOpen: true });
      this.setMessage(result.devicePreferences ? 'Workspace restored. Review this computer’s startup and schedule preferences before enabling them.' : 'Workspace restored successfully.', 'good');
      window.Scout?.loadOpportunities?.();
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async applyRestoredPreferences() {
    this.setMessage('Applying the settings you selected for this computer…');
    try {
      if (this.el('restore-start-with-windows')?.checked) {
        await requestJson('/api/device/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startWithWindows: true }),
        });
      }
      if (this.el('restore-daily-schedule')?.checked) {
        for (const run of (this.status?.config?.schedule?.jobs || []).filter((job) => job.enabled)) {
          await requestJson('/api/schedule', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'install', id: run.id, time: run.time, provider: run.provider, mode: run.mode }),
          });
        }
      }
      this.restoredPreferences = null;
      await this.refreshStatus({ keepOpen: true });
      this.render();
      this.setMessage('Selected settings are active on this computer.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  backupPanelHtml() {
    const sync = this.status?.sync || { state: 'disabled' };
    const git = this.status?.git || {};
    const gitReady = Boolean(git.installed);
    const labels = {
      synced: 'Synced', syncing: 'Backing up', offline: 'Offline — changes saved locally',
      pending: 'Backup pending', 'needs-attention': 'Needs attention', disabled: 'Not enabled', 'setup-required': 'Git setup required',
    };
    if (this.pendingRecoveryKey) return `<section class="setup-callout recovery-key-panel" role="status" aria-labelledby="recovery-key-title"><strong id="recovery-key-title">Save your emergency recovery key</strong><p>This key can restore Scout if you forget the passphrase. It will disappear after you confirm it is saved.</p><code id="setup-recovery-key" class="recovery-key" tabindex="0">${this.escape(this.pendingRecoveryKey)}</code><p><button id="setup-copy-recovery" class="act" type="button">Copy key</button> <button id="setup-save-recovery" class="act" type="button">Save key to file</button></p><label class="setup-field"><span><input id="setup-confirm-recovery" type="checkbox"> I saved the recovery key somewhere secure</span></label><p><button id="setup-finish-recovery" class="act primary" type="button">Finish backup setup</button></p></section>`;
    if (sync.enabled) return `<div class="setup-callout"><strong>Private backup: Connected</strong><p>Status: ${this.escape(labels[sync.state] || sync.state)}. Your private GitHub repository is connected. Automatic backup can be turned off without deleting local work or GitHub history.</p><p class="meta">Last successful backup: ${this.escape(sync.lastSuccessfulAt ? formatLocalDateTime(sync.lastSuccessfulAt, this.status?.config?.locale) : 'pending')}</p>${sync.error ? `<details><summary>Technical details</summary><pre class="setup-preview">${this.escape(sync.error)}</pre></details>` : ''}<p><button id="setup-backup-now" class="act" type="button">Back up now</button> ${['offline', 'pending', 'needs-attention'].includes(sync.state) ? '<button id="setup-retry-backup" class="act" type="button">Retry</button> ' : ''}<button id="setup-disable-backup" class="act" type="button">Turn off automatic backup</button></p></div>`;
    return `<div class="setup-callout"><strong>Private backup: Not set up (optional)</strong><p>Scout works fully on this computer without GitHub. Viewing this guide does not enable backup. A private repository lets you restore on another computer. Tracked career files are readable in that private repository; credentials, generated documents and chat transcripts are encrypted.</p><p><button id="setup-show-backup" class="act" type="button">Set up private backup</button> <button id="setup-skip-backup" class="act" type="button">Not now</button></p><div id="setup-backup-form" class="hidden"><p>${gitReady ? 'Git is ready. Desktop HTTPS uses Git Credential Manager; an unattended VPS can use a repository-scoped SSH deploy key.' : 'Install Git before connecting a private repository.'}</p>${gitReady ? '' : '<p><a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">Install Git</a> <button id="setup-backup-check-git" class="act" type="button">Check again</button></p>'}<p>Use an empty repository named <code>scout-workspace</code> and select <strong>Private</strong>. For VPS SSH, prepare the key here, add the displayed public key to that repository as a write-enabled deploy key, then connect using its SSH URL.</p><p><button id="setup-prepare-deploy-key" class="act" type="button" ${gitReady ? '' : 'disabled'}>Prepare VPS deploy key</button></p><pre id="setup-deploy-public-key" class="setup-preview hidden"></pre><label class="setup-field">Repository HTTPS or SSH URL<input id="setup-backup-url" type="text" placeholder="git@github.com:your-name/scout-workspace.git"></label><label class="setup-field">Recovery passphrase (at least 12 characters)<input id="setup-backup-passphrase" type="password" autocomplete="new-password"></label><label class="setup-field"><span><input id="setup-backup-confirm" type="checkbox"> I understand tracked career files are readable in my private repository and I will save the emergency recovery key.</span></label><p><button id="setup-connect-backup" class="act primary" type="button" ${gitReady ? '' : 'disabled'}>Connect and create first backup</button></p></div></div>`;
  },

  bindBackupPanel() {
    // Both controls must visibly change the panel. "Not now" previously only
    // printed a message and left the identical panel in place, so it read as a
    // choice that did nothing.
    this.el('setup-show-backup')?.addEventListener('click', () => {
      this.el('setup-backup-form').classList.remove('hidden');
      this.el('setup-show-backup').disabled = true;
      this.setMessage('Follow the steps below to connect a private backup repository.');
    });
    this.el('setup-skip-backup')?.addEventListener('click', () => {
      this.el('setup-backup-form').classList.add('hidden');
      if (this.el('setup-show-backup')) this.el('setup-show-backup').disabled = false;
      this.setMessage('Private backup skipped. You can enable it later in Settings.', 'good');
    });
    this.el('setup-backup-check-git')?.addEventListener('click', () => location.reload());
    this.el('setup-prepare-deploy-key')?.addEventListener('click', () => this.prepareDeployKey());
    this.el('setup-connect-backup')?.addEventListener('click', () => this.connectBackup());
    this.el('setup-backup-now')?.addEventListener('click', () => this.backupNow());
    this.el('setup-retry-backup')?.addEventListener('click', () => this.retryBackup());
    this.el('setup-disable-backup')?.addEventListener('click', () => this.disableBackup());
    this.el('setup-copy-recovery')?.addEventListener('click', () => this.copyRecoveryKey());
    this.el('setup-save-recovery')?.addEventListener('click', () => this.saveRecoveryKey());
    this.el('setup-finish-recovery')?.addEventListener('click', () => this.finishRecoveryKey());
  },

  async connectBackup() {
    const remoteUrl = fieldValue('setup-backup-url').trim();
    const passphrase = fieldValue('setup-backup-passphrase');
    if (!this.el('setup-backup-confirm')?.checked) return this.setMessage('Confirm the private-repository and recovery-key notice first.', 'error');
    this.setMessage('Checking privacy, signing in and creating the first backup…');
    try {
      const result = await requestJson('/api/sync/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remoteUrl, passphrase }) });
      this.pendingRecoveryKey = result.recoveryKey;
      await this.refreshStatus({ keepOpen: true }); this.render();
      this.setMessage(result.status?.state === 'synced'
        ? 'First backup complete. Save the emergency recovery key to finish.'
        : 'Private backup is enabled, but the GitHub copy is still pending. Save the emergency recovery key, then use Retry when the connection is available.', result.status?.state === 'synced' ? 'good' : 'error');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async prepareDeployKey() {
    this.setMessage('Creating a dedicated key and pinning GitHub host identity…');
    try {
      const result = await requestJson('/api/sync/deploy-key', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const output = this.el('setup-deploy-public-key');
      output.textContent = result.publicKey;
      output.classList.remove('hidden');
      this.setMessage('Deploy key prepared. Add this public key to the private repository with write access, then connect its SSH URL.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async copyRecoveryKey() {
    try {
      await navigator.clipboard.writeText(this.pendingRecoveryKey);
    } catch {
      const key = this.el('setup-recovery-key');
      const range = document.createRange(); range.selectNodeContents(key);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('copy'); selection.removeAllRanges();
    }
    this.setMessage('Recovery key copied.', 'good');
  },

  saveRecoveryKey() {
    const content = `Scout emergency recovery key\n\n${this.pendingRecoveryKey}\n\nKeep this file private. Either this key or your recovery passphrase can restore the encrypted Scout backup.\n`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'scout-recovery-key.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.setMessage('Recovery-key file prepared. Store it somewhere secure.', 'good');
  },

  async finishRecoveryKey() {
    if (!this.el('setup-confirm-recovery')?.checked) return this.setMessage('Confirm that you saved the recovery key first.', 'error');
    try {
      await requestJson('/api/sync/recovery-key/confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      this.pendingRecoveryKey = null;
      this.render();
      this.setMessage(this.status?.sync?.state === 'synced'
        ? 'Private backup is enabled and up to date.'
        : 'Recovery key confirmed. Your GitHub backup is still pending; Scout will retry automatically.', this.status?.sync?.state === 'synced' ? 'good' : 'error');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async backupNow() {
    try {
      const result = await requestJson('/api/sync/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'manual backup' }) });
      await this.refreshStatus({ keepOpen: true }); this.render();
      this.setMessage(result.state === 'synced' ? 'Backup completed.' : 'Saved locally. The GitHub backup is still pending.', result.state === 'synced' ? 'good' : 'error');
    }
    catch (error) { this.setMessage(error.message, 'error'); }
  },

  async retryBackup() {
    try {
      const result = await requestJson('/api/sync/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await this.refreshStatus({ keepOpen: true }); this.render();
      this.setMessage(result.state === 'synced' ? 'Backup is synced.' : 'Scout still needs attention. Your work remains saved locally.', result.state === 'synced' ? 'good' : 'error');
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async disableBackup() {
    if (!window.confirm('Turn off automatic backup on this computer? Local work and existing GitHub history will remain.')) return;
    try { await requestJson('/api/sync/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await this.refreshStatus({ keepOpen: true }); this.render(); this.setMessage('Automatic backup is off.', 'good'); }
    catch (error) { this.setMessage(error.message, 'error'); }
  },

  async generateProposal() {
    this.setMessage('Starting one bounded, evidence-led proposal…');
    try {
      const result = await requestJson('/api/setup/proposal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: this.status?.config?.ai?.provider }) });
      this.operations.proposal = result.operation;
      this.render();
      this.watchOperation('proposal', result.operation.id);
    } catch (error) { this.setMessage(error.message, 'error'); }
  },

  async recoverMasterCv() {
    if (!window.confirm('Restore the reviewed staged master CV? Scout will back up the current file first and revalidate the workspace.')) return;
    this.setBusy(true);
    try {
      await requestJson('/api/setup/recovery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
      await this.refreshStatus({ keepOpen: true }); this.render();
      this.setMessage('The reviewed master CV was restored and the previous file was backed up.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async activateProposal() {
    if (!this.proposal || !window.confirm('Activate exactly the reviewed staged files? Scout will create backups first.')) return;
    this.setBusy(true);
    try {
      await requestJson('/api/setup/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId: this.proposal.proposalId, confirmed: true }) });
      await this.refreshStatus({ keepOpen: true }); this.render(); this.setMessage('Proposal activated from trusted Scout controls. No extra AI turn was used.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async discardProposal() {
    this.setBusy(true);
    try {
      await requestJson('/api/setup/proposal', { method: 'DELETE', headers: { 'content-type': 'application/json' } });
      await this.refreshStatus({ keepOpen: true }); this.render(); this.setMessage('Staged proposal discarded.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  selectedScheduleDays(row) {
    return [...row.querySelectorAll('[data-schedule-day]')]
      .filter((box) => box.checked)
      .map((box) => Number(box.dataset.scheduleDay));
  },

  async saveSchedule({ id, provider, mode, time, model = null, days = null }) {
    this.setBusy(true);
    try {
      await requestJson('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        action: 'install', id, time: time || '07:30', provider, mode, model, days,
      }) });
      await this.refreshStatus({ keepOpen: true }); this.step = STEPS.length - 1; this.render();
      const run = (this.status?.schedule?.runs || []).find((item) => item.id === id);
      this.setMessage(`${provider} ${mode === 'primary' ? 'scan' : 'verification pass'} saved: ${run?.daysLabel || 'Every day'} at ${run?.time || time}.`, 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  async disableSchedule(id) {
    this.setBusy(true);
    try {
      await requestJson('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', id }) });
      await this.refreshStatus({ keepOpen: true }); this.step = STEPS.length - 1; this.render(); this.setMessage('Scheduled job disabled.', 'good');
    } catch (error) { this.setMessage(error.message, 'error'); }
    finally { this.setBusy(false); }
  },

  openScoutChat(prefill = 'ask') {
    window.Scout?.openChat?.('setup-onboarding', prefill);
  },

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  },

  move(delta) {
    if (this.busy) return;
    if (this.atRetuneEntry() && delta < 0) {
      this.showSettingsHub();
      return;
    }
    if (this.step === 2 && delta < 0 && this.preferenceStep > 0) {
      this.capturePreferenceQuestion();
      this.preferenceStep -= 1;
      this.render();
      return;
    }
    this.step = Math.max(0, Math.min(STEPS.length - 1, this.step + delta));
    this.render();
  },

  selectedProvider() {
    return document.querySelector('input[name="setup-provider"]:checked:not(:disabled)')?.value || '';
  },

  selectableProviders() {
    return [...document.querySelectorAll('input[name="setup-provider"]:not(:disabled)')].map((input) => input.value);
  },

  readPreferences() {
    return buildConfig(this.preferenceDraft || {}, this.status?.config);
  },

  async next() {
    if (this.busy) return;
    if (this.statusRetry) return this.retryStatus();
    try {
      this.setBusy(true);
      if (this.incrementalSection) {
        await this.saveDeviceSetting();
        await requestJson('/api/setup/section', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this.incrementalSection.id, action: 'complete' }) });
        this.incrementalSection = null;
        this.view = 'closed';
        this.el('setup-overlay').classList.add('hidden');
        return;
      }
      if (this.step === 0 && this.status?.device) {
        const enabled = Boolean(this.el('setup-start-with-windows')?.checked);
        if (enabled !== Boolean(this.status.device.startWithWindows)) await this.saveDeviceSetting();
      }
      if (this.step === 1) {
        const provider = this.selectedProvider();
        // Blaming sign-in is wrong when a provider is already authenticated and
        // the person simply has not picked one yet.
        if (!provider) throw new Error(this.selectableProviders().length
          ? 'Choose a provider to continue.'
          : 'Sign in to Codex or Claude, refresh the status, then choose it.');
        const result = await requestJson('/api/setup/config', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ai: { provider, model: null } }),
        });
        this.status.config = result.config;
      }
      if (this.step === 2) {
        this.capturePreferenceQuestion();
        if (this.preferenceStep < 4) {
          this.preferenceStep += 1;
          this.renderPreferences();
          return;
        }
        const config = this.readPreferences();
        if (!config.profile.displayName) throw new Error('Enter your name so Scout can identify the workspace profile.');
        if (!config.search.roleFamilies.length) throw new Error('Add at least one role family or job title to search for.');
        if (!config.search.locations.length) throw new Error('Add at least one location or enter Remote.');
        if (!Number.isFinite(config.search.salaryMinimum) && config.search.salaryMinimum !== null) throw new Error('Minimum salary must be a number or blank.');
        if (!config.locale || !config.currency || !config.timezone) throw new Error('Locale, currency and timezone are required.');
        const result = await requestJson('/api/setup/config', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config),
        });
        this.status.config = result.config;
        window.Scout?.applyWorkspaceConfig?.(result.config);
      }
      if (this.step === 3) {
        const appId = fieldValue('setup-adzuna-id').trim();
        const apiKey = fieldValue('setup-adzuna-key').trim();
        if ((appId && !apiKey) || (!appId && apiKey)) throw new Error('Enter both Adzuna values, or leave both blank to skip.');
        if (appId && apiKey) {
          const result = await requestJson('/api/setup/credentials', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, apiKey }),
          });
          this.status.adzunaConfigured = result.configured;
          this.el('setup-adzuna-id').value = '';
          this.el('setup-adzuna-key').value = '';
        }
      }
      if (this.step === 4 && !this.imported) {
        const file = this.el('setup-cv-file')?.files?.[0];
        if (file) {
          validateCvName(file.name);
          if (file.size > 10 * 1024 * 1024) throw new Error('CV must be no larger than 10 MB.');
          this.setMessage('Extracting CV locally…');
          const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
          this.imported = await requestJson('/api/setup/import-cv', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, base64 }),
          });
          this.renderImport();
          this.setMessage('CV imported. Review the extracted preview, then continue.', 'good');
          return;
        }
      }
      if (this.step === 4) {
        this.status = await requestJson('/api/setup/status');
        window.Scout?.applyWorkspaceConfig?.(this.status.config);
      }
      if (this.step === 5) {
        await this.refreshStatus({ keepOpen: true });
        if (!this.status?.ready) throw new Error('Generate, review and activate a complete proposal before the first scan.');
        this.step += 1;
        this.render();
        if (shouldAutoRunFirstScan(this.status?.scanHealth, this.status?.ready)) setTimeout(() => this.runSupervisedScan(), 0);
        return;
      }
      if (this.step === STEPS.length - 1) {
        const result = await requestJson('/api/setup/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        this.status.setupComplete = Boolean(result.completedAt);
        localStorage.removeItem(SETUP_DEFERRED_KEY);
        if (this.view === 'retune') {
          this.showSettingsHub();
          return;
        }
        this.view = 'closed';
        this.el('setup-overlay').classList.add('hidden');
        return;
      }
      this.step += 1;
      this.render();
    } catch (error) {
      this.setMessage(error.message, 'error');
    } finally {
      this.setBusy(false);
    }
  },

  async copyPrompt() {
    const input = this.el('setup-ai-prompt');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    this.setMessage('Onboarding prompt copied.', 'good');
  },

  deferSetup() {
    if (this.incrementalSection) {
      requestJson('/api/setup/section', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this.incrementalSection.id, action: 'defer' }) })
        .then(() => { this.incrementalSection = null; this.view = 'closed'; this.el('setup-overlay').classList.add('hidden'); })
        .catch((error) => this.setMessage(error.message, 'error'));
      return;
    }
    if (!this.status?.trackerExists || this.status?.ready) return;
    localStorage.setItem(SETUP_DEFERRED_KEY, 'true');
    this.view = 'closed';
    this.el('setup-overlay').classList.add('hidden');
  },
};

if (typeof window !== 'undefined') window.ScoutSetup = Setup;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Setup.init());
  else Setup.init();
}
