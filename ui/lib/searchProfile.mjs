import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { backupWorkspace, workspacePaths } from './workspace.mjs';
import { createBeta22WorkspaceSnapshot } from './workspaceMigration.mjs';

export const PREFERENCE_STRENGTHS = Object.freeze([
  'mandatory', 'strong-preference', 'nice-to-have',
  'neutral', 'strong-negative', 'hard-exclusion',
]);

export const PROVENANCE = Object.freeze([
  'explicit', 'deterministic-derivation', 'confirmed-inference', 'unconfirmed-inference',
]);

export const UNKNOWN_POLICIES = Object.freeze(['include', 'penalise', 'exclude']);
export const COMPENSATION_AMOUNT_TYPES = Object.freeze(['base', 'total', 'rate', 'unknown']);
export const COMPENSATION_CERTAINTIES = Object.freeze(['exact', 'range', 'estimated', 'unknown']);
export const SEARCH_BREADTHS = Object.freeze(['focused', 'balanced', 'broad']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) throw new Error(`${name} must be an object`);
}

function requireEnum(value, values, name) {
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(', ')}`);
}

function validateRule(rule, name) {
  requirePlainObject(rule, name);
  if (typeof rule.value !== 'string' || !rule.value.trim()) throw new Error(`${name}.value must be a non-empty string`);
  requireEnum(rule.strength, PREFERENCE_STRENGTHS, `${name}.strength`);
  requireEnum(rule.provenance, PROVENANCE, `${name}.provenance`);
  if (rule.strength === 'hard-exclusion' && !['explicit', 'confirmed-inference'].includes(rule.provenance)) {
    throw new Error(`${name} hard exclusion requires confirmation`);
  }
}

function validateRuleLists(section, name) {
  requirePlainObject(section, name);
  for (const [key, rules] of Object.entries(section)) {
    if (!Array.isArray(rules)) throw new Error(`${name}.${key} must be an array`);
    rules.forEach((rule, index) => validateRule(rule, `${name}.${key}[${index}]`));
  }
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('profile fingerprint values must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('profile fingerprint values must be JSON-compatible');
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

export function validateSearchProfile(profile) {
  requirePlainObject(profile, 'search profile');
  if (profile.version !== 1) throw new Error('search profile version must be 1');
  if (!['draft', 'published'].includes(profile.status)) throw new Error('search profile status must be draft or published');
  requirePlainObject(profile.target, 'search profile.target');
  requirePlainObject(profile.negative, 'search profile.negative');
  requirePlainObject(profile.compensation, 'search profile.compensation');
  validateRuleLists(profile.target, 'search profile.target');
  validateRuleLists(profile.negative, 'search profile.negative');

  const {
    currency, period, rateType, amountType, certainty, minimum, minimumStrength, unknownPolicy,
  } = profile.compensation;
  if (currency !== null && (typeof currency !== 'string' || !currency.trim())) throw new Error('search profile.compensation.currency must be a currency or null');
  if (typeof period !== 'string' || !period.trim()) throw new Error('search profile.compensation.period is required');
  if (rateType !== undefined && rateType !== null && (typeof rateType !== 'string' || !rateType.trim())) {
    throw new Error('search profile.compensation.rateType must be a rate type or null');
  }
  if (amountType !== undefined) {
    requireEnum(amountType, COMPENSATION_AMOUNT_TYPES, 'search profile.compensation.amountType');
  }
  if (certainty !== undefined) {
    requireEnum(certainty, COMPENSATION_CERTAINTIES, 'search profile.compensation.certainty');
  }
  if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0)) throw new Error('search profile.compensation.minimum must be a non-negative number or null');
  requireEnum(minimumStrength, PREFERENCE_STRENGTHS, 'search profile.compensation.minimumStrength');
  if (minimumStrength === 'hard-exclusion') throw new Error('search profile.compensation hard exclusion requires a rule provenance');
  requireEnum(unknownPolicy, UNKNOWN_POLICIES, 'search profile.compensation.unknownPolicy');

  if (profile.selection !== undefined) {
    requirePlainObject(profile.selection, 'search profile.selection');
    const fields = Object.keys(profile.selection);
    if (fields.some((field) => !['breadth', 'exploration', 'relevanceThreshold'].includes(field))) {
      throw new Error('search profile.selection contains an unsupported field');
    }
    requireEnum(profile.selection.breadth, SEARCH_BREADTHS, 'search profile.selection.breadth');
    const threshold = profile.selection.relevanceThreshold;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error('search profile.selection.relevanceThreshold must be between 0 and 100');
    }
    const exploration = profile.selection.exploration;
    if (!Number.isFinite(exploration) || exploration < 0 || exploration > 1) {
      throw new Error('search profile.selection.exploration must be between 0 and 1');
    }
  }

  if (profile.status === 'published') {
    if (typeof profile.publishedAt !== 'string' || Number.isNaN(Date.parse(profile.publishedAt))) throw new Error('published search profile requires a valid publishedAt');
  }
  if (profile.id !== undefined && (typeof profile.id !== 'string' || !/^profile-[a-f0-9]{12}$/.test(profile.id))) {
    throw new Error('search profile id must be a profile fingerprint');
  }
  return profile;
}

export function profileFingerprint(profile) {
  return crypto.createHash('sha256').update(canonicalJson(profile)).digest('hex');
}

function derivedRules(values, strength) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => ({ value, strength, provenance: 'deterministic-derivation' }));
}

export function draftProfileFromLegacy(config = {}, context = '') {
  const search = isPlainObject(config.search) ? config.search : {};
  const minimum = Number.isFinite(search.salaryMinimum) && search.salaryMinimum >= 0 ? search.salaryMinimum : null;
  const draft = {
    version: 1,
    status: 'draft',
    target: {
      primaryTitles: derivedRules(search.roleFamilies, 'strong-preference'),
      locations: derivedRules(search.locations, 'strong-preference'),
      sectors: [],
    },
    negative: {
      excludedTitles: [],
      excludedResponsibilities: derivedRules(search.exclusions, 'strong-negative'),
    },
    compensation: {
      currency: typeof config.currency === 'string' && config.currency.trim() ? config.currency : null,
      period: 'year',
      rateType: minimum === null ? null : 'salary',
      amountType: minimum === null ? 'unknown' : 'base',
      certainty: minimum === null ? 'unknown' : 'exact',
      minimum,
      minimumStrength: minimum === null ? 'neutral' : 'strong-preference',
      unknownPolicy: 'include',
    },
  };
  void context;
  return validateSearchProfile(draft);
}

export function publishSearchProfile(draft, { publishedAt = new Date().toISOString() } = {}) {
  const validated = validateSearchProfile({ ...structuredClone(draft), status: 'published', publishedAt });
  const fingerprint = profileFingerprint({ ...validated, id: undefined });
  return deepFreeze({ ...validated, id: `profile-${fingerprint.slice(0, 12)}` });
}

export function loadPublishedSearchProfile(root) {
  const file = workspacePaths(root).searchProfilePublished;
  if (!fs.existsSync(file)) return null;
  const profile = validateSearchProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (profile.status !== 'published') throw new Error(`published search profile is not published: ${file}`);
  const expectedId = `profile-${profileFingerprint({ ...profile, id: undefined }).slice(0, 12)}`;
  if (profile.id !== expectedId) throw new Error(`published search profile fingerprint does not match: ${file}`);
  return deepFreeze(profile);
}

export function migrateSearchProfile(root, { fileSystem = fs } = {}) {
  const paths = workspacePaths(root);
  const rollback = createBeta22WorkspaceSnapshot(root);
  if (fileSystem.existsSync(paths.searchProfileDraft) || fileSystem.existsSync(paths.searchProfilePublished)) {
    return {
      migrated: false,
      draftPath: paths.searchProfileDraft,
      backupPath: null,
      rollbackSnapshotPath: rollback.directory,
    };
  }
  if (!fileSystem.existsSync(paths.config)) throw new Error(`workspace config missing: ${paths.config}`);

  // Retain the legacy source text itself as evidence, rather than reserialising
  // parsed values and silently losing formatting or line endings.
  const workspaceJson = fileSystem.readFileSync(paths.config, 'utf8');
  const context = fileSystem.existsSync(paths.profileContext) ? fileSystem.readFileSync(paths.profileContext, 'utf8') : '';
  const config = JSON.parse(workspaceJson);
  const draft = draftProfileFromLegacy(config, context);
  const backupPath = backupWorkspace(root, 'search-profile-v1');
  const searchDirectory = path.dirname(paths.searchProfileRaw);
  if (fileSystem.existsSync(searchDirectory)) throw new Error(`search profile evidence already exists: ${searchDirectory}`);
  const stagingDirectory = path.join(paths.profile, `.search-profile-v1-${crypto.randomUUID()}`);
  let configWritten = false;
  try {
    atomicWriteFile(path.join(stagingDirectory, 'raw.json'), `${JSON.stringify({ version: 1, workspaceJson, context }, null, 2)}\n`, { fileSystem });
    atomicWriteFile(path.join(stagingDirectory, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, { fileSystem });
    atomicWriteFile(paths.config, `${JSON.stringify({
      ...config,
      searchProfile: { ...(config.searchProfile || {}), publishedId: null },
    }, null, 2)}\n`, { fileSystem });
    configWritten = true;
    fileSystem.renameSync(stagingDirectory, searchDirectory);
  } catch (error) {
    if (configWritten) atomicWriteFile(paths.config, fileSystem.readFileSync(backupPath), { fileSystem });
    fileSystem.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    migrated: true,
    draftPath: paths.searchProfileDraft,
    backupPath,
    rollbackSnapshotPath: rollback.directory,
  };
}
