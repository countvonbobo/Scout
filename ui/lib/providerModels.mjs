// Models Scout offers when choosing an engine for a conversation.
//
// Legacy conversation callers still use this small merge helper. The engine
// picker below uses explicit catalogue records instead: refreshed Codex data
// when the installed CLI can provide it, bundled suggestions when it cannot,
// observed Claude identifiers, and the saved setting. Codex session logs remain
// deliberately excluded because collaboration-mode names and base models share
// a field there and are not a trustworthy availability source.
const CURATED = Object.freeze({
  claude: Object.freeze([
    { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' },
  ]),
  codex: Object.freeze([]),
});

const SAFE_MODEL = /^[A-Za-z0-9._:-]+$/;
// The current Codex catalogue is just under 300 KiB because each record also
// carries instructions and capability metadata. Keep enough headroom for that
// supported payload while still enforcing a firm pre-parse ceiling.
const MAX_CATALOGUE_BYTES = 512 * 1024;
const MAX_CATALOGUE_MODELS = 100;

const MODEL_DETAILS = Object.freeze({
  'gpt-5.6-sol': Object.freeze({
    label: 'GPT-5.6 Sol',
    tradeoff: 'Most capable for complex, open-ended work.',
  }),
  'gpt-5.6-terra': Object.freeze({
    label: 'GPT-5.6 Terra',
    tradeoff: 'Balanced everyday workhorse.',
  }),
  'gpt-5.6-luna': Object.freeze({
    label: 'GPT-5.6 Luna',
    tradeoff: 'Fast for clear, repeatable work.',
  }),
  'claude-opus-4-8': Object.freeze({
    label: 'Opus 4.8',
    tradeoff: 'Most capable bundled Claude suggestion.',
  }),
  'claude-sonnet-5': Object.freeze({
    label: 'Sonnet 5',
    tradeoff: 'Balanced bundled Claude suggestion.',
  }),
  'claude-haiku-4-5': Object.freeze({
    label: 'Haiku 4.5',
    tradeoff: 'Fastest bundled Claude suggestion.',
  }),
});

const BUNDLED = Object.freeze({
  codex: Object.freeze(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
  claude: Object.freeze(['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']),
});

export function isSafeModelId(value) {
  return SAFE_MODEL.test(String(value || ''));
}

function label(id, curated) {
  return curated.find((model) => model.id === id)?.label || id;
}

// `detected` comes from the local usage logs; `configured` is the settings default.
export function providerModels(provider, { detected = [], configured = null } = {}) {
  const curated = CURATED[provider] || [];
  const ids = [
    ...curated.map((model) => model.id),
    ...detected.map((value) => String(value || '').trim()),
    ...(configured ? [String(configured).trim()] : []),
  ].filter((id) => id && isSafeModelId(id));
  return [...new Set(ids)].map((id) => ({
    id,
    label: label(id, curated),
    detected: detected.includes(id),
  }));
}

// Models seen in this machine's own Claude logs, heaviest usage first. These are
// real model identifiers taken from each turn's `message.model`.
export function detectedModels(usage = {}) {
  const claude = (usage.claude?.byModel || []).map((entry) => entry.model);
  return { claude: [...new Set(claude.filter(isSafeModelId))], codex: [] };
}

function byteLength(value) {
  const text = String(value || '');
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text);
  return new TextEncoder().encode(text).byteLength;
}

export function parseCodexModelCatalogue(output, { maxBytes = MAX_CATALOGUE_BYTES } = {}) {
  const text = String(output || '');
  if (byteLength(text) > maxBytes) throw new Error('model catalogue output is too large');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('invalid model catalogue JSON'); }
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length > MAX_CATALOGUE_MODELS) {
    throw new Error('invalid model catalogue shape');
  }
  const models = [];
  const seen = new Set();
  for (const item of parsed.models) {
    if (!item || typeof item !== 'object') continue;
    if (item.visibility != null && item.visibility !== 'list') continue;
    const id = String(item.slug || item.model || item.id || '').trim();
    if (!isSafeModelId(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      isDefault: item.is_default === true || item.isDefault === true,
      priority: Number.isFinite(item.priority) ? item.priority : null,
    });
  }
  if (!models.length) throw new Error('invalid model catalogue: no safe models');
  if (!models.some((model) => model.isDefault)) {
    const ranked = models.filter((model) => model.priority != null)
      .sort((left, right) => left.priority - right.priority);
    if (ranked.length) ranked[0].isDefault = true;
  }
  return {
    models: models.map(({ id, isDefault }) => ({ id, isDefault })),
  };
}

function modelDetails(id, source) {
  if (MODEL_DETAILS[id]) return MODEL_DETAILS[id];
  return {
    label: id,
    tradeoff: source === 'refreshed'
      ? 'Available from the installed provider catalogue.'
      : source === 'observed'
        ? 'Seen in local usage; current provider availability is unknown.'
        : source === 'configured'
          ? 'Configured exact model ID; availability is not verified.'
          : 'Custom exact model ID; availability is checked when the provider runs.',
  };
}

function catalogueRecord(id, source, available) {
  const details = modelDetails(id, source);
  return {
    id,
    label: details.label,
    tradeoff: details.tradeoff,
    source,
    available,
    selected: false,
  };
}

function safeIds(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(isSafeModelId))];
}

export function providerModelCatalogue(provider, status = {}) {
  const records = new Map();
  const refreshed = status.state === 'refreshed';
  const add = (record) => {
    const existing = records.get(record.id);
    if (!existing) records.set(record.id, record);
  };

  if (refreshed) {
    for (const model of status.models || []) {
      const id = String(model?.id || '').trim();
      if (!isSafeModelId(id)) continue;
      add(catalogueRecord(id, 'refreshed', true));
    }
  } else {
    for (const id of BUNDLED[provider] || []) add(catalogueRecord(id, 'bundled', 'unknown'));
  }

  if (provider === 'claude') {
    for (const id of safeIds(status.detected)) add(catalogueRecord(id, 'observed', 'unknown'));
  }

  const configured = isSafeModelId(status.configured) ? String(status.configured).trim() : null;
  if (configured && !records.has(configured)) {
    const record = catalogueRecord(configured, 'configured', refreshed ? false : 'unknown');
    if (refreshed) record.tradeoff = 'Configured model is absent from the refreshed catalogue.';
    add(record);
  }
  for (const id of safeIds(status.custom)) add(catalogueRecord(id, 'custom', 'unknown'));

  const rejected = new Set(safeIds(status.rejected));
  for (const id of rejected) {
    if (!records.has(id)) add(catalogueRecord(id, 'configured', false));
    const record = records.get(id);
    record.available = false;
    record.selected = false;
    record.tradeoff = 'Provider rejected this model; choose another model deliberately.';
  }

  if (configured && records.has(configured) && records.get(configured).available !== false) {
    records.get(configured).selected = true;
  } else if (!configured) {
    const providerDefault = (status.models || []).find((model) => model?.isDefault === true);
    const record = providerDefault && records.get(providerDefault.id);
    if (record?.available === true) record.selected = true;
  }

  return [...records.values()];
}

function configuredModel(provider, config) {
  if (typeof config === 'string') return config;
  return config?.configured
    ?? config?.models?.[provider]
    ?? config?.ai?.models?.[provider]
    ?? (config?.ai?.provider === provider ? config?.ai?.model : null)
    ?? null;
}

export function effectiveProviderModel(provider, config, catalogue = []) {
  const configured = String(configuredModel(provider, config) || '').trim();
  const chosen = configured && isSafeModelId(configured)
    ? catalogue.find((model) => model.id === configured)
    : catalogue.find((model) => model.selected);
  if (!chosen) {
    return {
      id: null,
      label: 'Provider default (model unknown)',
      source: null,
      available: 'unknown',
      known: false,
      state: 'unknown',
    };
  }
  return {
    id: chosen.id,
    label: chosen.label,
    source: chosen.source,
    available: chosen.available,
    known: true,
    state: chosen.available === false ? 'stale' : configured ? 'configured' : 'provider-default',
  };
}
