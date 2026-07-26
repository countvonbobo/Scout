import crypto from 'node:crypto';
import fs from 'node:fs';
import { workspacePaths } from './workspace.mjs';

export const PREFERENCE_STRENGTHS = Object.freeze([
  'mandatory', 'strong-preference', 'nice-to-have',
  'neutral', 'strong-negative', 'hard-exclusion',
]);

export const PROVENANCE = Object.freeze([
  'explicit', 'deterministic-derivation', 'confirmed-inference', 'unconfirmed-inference',
]);

export const UNKNOWN_POLICIES = Object.freeze(['include', 'penalise', 'exclude']);

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

  const { currency, period, minimum, minimumStrength, unknownPolicy } = profile.compensation;
  if (currency !== null && (typeof currency !== 'string' || !currency.trim())) throw new Error('search profile.compensation.currency must be a currency or null');
  if (typeof period !== 'string' || !period.trim()) throw new Error('search profile.compensation.period is required');
  if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0)) throw new Error('search profile.compensation.minimum must be a non-negative number or null');
  requireEnum(minimumStrength, PREFERENCE_STRENGTHS, 'search profile.compensation.minimumStrength');
  requireEnum(unknownPolicy, UNKNOWN_POLICIES, 'search profile.compensation.unknownPolicy');

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
  return deepFreeze(profile);
}
