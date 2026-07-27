import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workspacePaths } from './workspace.mjs';

export const RUN_JOURNAL_SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_METADATA_STRING_LENGTH = 128;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_PROPERTY = /(?:token|secret|password|credential|authorization|cookie|prompt|transcript|advert|cv|content|response|path|email|phone)/i;
const PAYLOAD_SCHEMA = Object.freeze({
  1: Object.freeze(new Set(['schemaVersion', 'stableIds', 'counts', 'digests', 'versions', 'artifacts', 'metadata'])),
});

export class JournalCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

function stableJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('journal values must be finite JSON values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('journal values must be plain JSON objects');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function requireText(value, name, ErrorType = TypeError) {
  if (typeof value !== 'string' || !value.trim()) throw new ErrorType(`journal ${name} is required`);
  return value;
}

function requireSafeToken(value, name, ErrorType = TypeError) {
  const token = requireText(value, name, ErrorType);
  if (token.length > MAX_METADATA_STRING_LENGTH || !SAFE_TOKEN.test(token)) {
    throw new ErrorType(`journal ${name} must be a bounded identifier`);
  }
  return token;
}

function requireSafeProperty(property, name, ErrorType) {
  if (!SAFE_TOKEN.test(property) || SENSITIVE_PROPERTY.test(property)) {
    throw new ErrorType(`journal payload ${name} contains an unsafe property`);
  }
}

function requirePlainObject(value, name, ErrorType) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ErrorType(`journal payload ${name} must be an object`);
  }
  return value;
}

function validateTokenMap(value, name, ErrorType) {
  for (const [property, token] of Object.entries(requirePlainObject(value, name, ErrorType))) {
    requireSafeProperty(property, name, ErrorType);
    try {
      requireSafeToken(token, `${name}.${property}`, ErrorType);
    } catch {
      throw new ErrorType(`journal payload ${name}.${property} must be a bounded identifier`);
    }
  }
}

function validateCountMap(value, ErrorType) {
  for (const [property, count] of Object.entries(requirePlainObject(value, 'counts', ErrorType))) {
    requireSafeProperty(property, 'counts', ErrorType);
    if (!Number.isSafeInteger(count) || count < 0) throw new ErrorType('journal payload counts must contain non-negative whole numbers');
  }
}

function validateDigestMap(value, ErrorType) {
  for (const [property, digest] of Object.entries(requirePlainObject(value, 'digests', ErrorType))) {
    requireSafeProperty(property, 'digests', ErrorType);
    if (typeof digest !== 'string' || !SHA256.test(digest)) throw new ErrorType('journal payload digests must contain SHA-256 digests');
  }
}

function validateArtifactReferences(value, ErrorType) {
  if (!Array.isArray(value) || value.length > 32) throw new ErrorType('journal payload artifacts must be a bounded array');
  for (const artifact of value) {
    const reference = requirePlainObject(artifact, 'artifact reference', ErrorType);
    const keys = Object.keys(reference).sort();
    if (keys.join(',') !== 'digest,id,schemaVersion') throw new ErrorType('journal payload artifact reference is invalid');
    try {
      requireSafeToken(reference.id, 'artifact ID', ErrorType);
    } catch {
      throw new ErrorType('journal payload artifact reference is invalid');
    }
    if (!Number.isSafeInteger(reference.schemaVersion) || reference.schemaVersion < 1 || typeof reference.digest !== 'string' || !SHA256.test(reference.digest)) {
      throw new ErrorType('journal payload artifact reference is invalid');
    }
  }
}

function validatePayload(payload, ErrorType = TypeError) {
  const value = requirePlainObject(payload, 'payload', ErrorType);
  const allowed = PAYLOAD_SCHEMA[value.schemaVersion];
  if (!allowed) throw new ErrorType(`unsupported journal payload schema version: ${value.schemaVersion}`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ErrorType(`journal payload property is not allowed: ${key}`);
  }
  for (const key of ['stableIds', 'versions', 'metadata']) {
    if (value[key] !== undefined) validateTokenMap(value[key], key, ErrorType);
  }
  if (value.counts !== undefined) validateCountMap(value.counts, ErrorType);
  if (value.digests !== undefined) validateDigestMap(value.digests, ErrorType);
  if (value.artifacts !== undefined) validateArtifactReferences(value.artifacts, ErrorType);
  let encoded;
  try {
    encoded = stableJson(payload);
  } catch (error) {
    throw new ErrorType(error.message);
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) throw new ErrorType('journal payload exceeds the 16 KiB limit');
  return encoded;
}

function envelopeHash(event) {
  const { eventHash, ...envelope } = event;
  return sha256(envelope);
}

function isIncompleteJson(value) {
  let index = 0;
  const skipWhitespace = () => { while (/\s/.test(value[index] || '')) index += 1; };
  const parseString = () => {
    index += 1;
    while (index < value.length) {
      const character = value[index++];
      if (character === '"') return true;
      if (character < ' ') return false;
      if (character !== '\\') continue;
      if (index === value.length) return null;
      const escaped = value[index++];
      if ('"\\/bfnrt'.includes(escaped)) continue;
      if (escaped !== 'u') return false;
      for (let digits = 0; digits < 4; digits += 1) {
        if (index === value.length) return null;
        if (!/[0-9a-f]/i.test(value[index++])) return false;
      }
    }
    return null;
  };
  const parseLiteral = (literal) => {
    for (let offset = 0; offset < literal.length; offset += 1) {
      if (index + offset === value.length) return null;
      if (value[index + offset] !== literal[offset]) return false;
    }
    index += literal.length;
    return true;
  };
  const parseNumber = () => {
    if (value[index] === '-') {
      index += 1;
      if (index === value.length) return null;
    }
    if (value[index] === '0') {
      index += 1;
      if (/\d/.test(value[index] || '')) return false;
    } else if (/[1-9]/.test(value[index] || '')) {
      while (/\d/.test(value[index] || '')) index += 1;
    } else return false;
    if (value[index] === '.') {
      index += 1;
      if (index === value.length) return null;
      if (!/\d/.test(value[index])) return false;
      while (/\d/.test(value[index] || '')) index += 1;
    }
    if (value[index] === 'e' || value[index] === 'E') {
      index += 1;
      if (index === value.length) return null;
      if (value[index] === '+' || value[index] === '-') {
        index += 1;
        if (index === value.length) return null;
      }
      if (!/\d/.test(value[index])) return false;
      while (/\d/.test(value[index] || '')) index += 1;
    }
    return true;
  };
  const parseValue = () => {
    skipWhitespace();
    if (index === value.length) return null;
    if (value[index] === '{') return parseObject();
    if (value[index] === '[') return parseArray();
    if (value[index] === '"') return parseString();
    if (value[index] === 't') return parseLiteral('true');
    if (value[index] === 'f') return parseLiteral('false');
    if (value[index] === 'n') return parseLiteral('null');
    return parseNumber();
  };
  const parseObject = () => {
    index += 1;
    skipWhitespace();
    if (index === value.length) return null;
    if (value[index] === '}') { index += 1; return true; }
    while (true) {
      if (value[index] !== '"') return false;
      const property = parseString();
      if (property !== true) return property;
      skipWhitespace();
      if (index === value.length) return null;
      if (value[index++] !== ':') return false;
      const nested = parseValue();
      if (nested !== true) return nested;
      skipWhitespace();
      if (index === value.length) return null;
      if (value[index] === '}') { index += 1; return true; }
      if (value[index++] !== ',') return false;
      skipWhitespace();
      if (index === value.length) return null;
    }
  };
  const parseArray = () => {
    index += 1;
    skipWhitespace();
    if (index === value.length) return null;
    if (value[index] === ']') { index += 1; return true; }
    while (true) {
      const nested = parseValue();
      if (nested !== true) return nested;
      skipWhitespace();
      if (index === value.length) return null;
      if (value[index] === ']') { index += 1; return true; }
      if (value[index++] !== ',') return false;
      skipWhitespace();
      if (index === value.length) return null;
    }
  };
  const result = parseValue();
  if (result !== true) return result === null;
  skipWhitespace();
  return false;
}

function corrupt(message) {
  return new JournalCorruptionError(message);
}

function validateEvent(event, { runId, sequence, previousHash }) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw corrupt('journal event must be an object');
  if (event.schemaVersion !== RUN_JOURNAL_SCHEMA_VERSION) throw corrupt(`unsupported journal schema version: ${event.schemaVersion}`);
  if (runId !== null && event.runId !== runId) throw corrupt('journal run ID changed');
  requireSafeToken(event.runId, 'run ID', JournalCorruptionError);
  if (event.sequence !== sequence) throw corrupt(`journal sequence must be ${sequence}`);
  if (typeof event.eventId !== 'string' || !UUID.test(event.eventId)) throw corrupt('journal event ID is invalid');
  requireSafeToken(event.type, 'event type', JournalCorruptionError);
  requireSafeToken(event.stageId, 'stage ID', JournalCorruptionError);
  requireSafeToken(event.idempotencyKey, 'idempotency key', JournalCorruptionError);
  requireSafeToken(event.leaseId, 'lease ID', JournalCorruptionError);
  if (!Number.isInteger(event.fencingGeneration) || event.fencingGeneration < 1) throw corrupt('journal fencing generation must be a positive integer');
  if (typeof event.recordedAt !== 'string' || Number.isNaN(Date.parse(event.recordedAt)) || !event.recordedAt.endsWith('Z')) throw corrupt('journal recordedAt must be a UTC timestamp');
  validatePayload(event.payload, JournalCorruptionError);
  if (event.payloadHash !== sha256(event.payload)) throw corrupt('journal payload hash is invalid');
  if (event.previousHash !== previousHash) throw corrupt('journal previous hash is invalid');
  if (typeof event.eventHash !== 'string' || !/^[a-f0-9]{64}$/.test(event.eventHash)) throw corrupt('journal event hash is invalid');
  if (event.eventHash !== envelopeHash(event)) throw corrupt('journal event hash is invalid');
}

export function validateRunJournal(file) {
  if (!fs.existsSync(file)) return { events: [], lastHash: null, truncatedTail: false };
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents) return { events: [], lastHash: null, truncatedTail: false };
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  let previousHash = null;
  let runId = null;
  let truncatedTail = false;
  const eventIds = new Set();
  const idempotencyKeys = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const finalLine = index === lines.length - 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (finalLine && isIncompleteJson(line)) {
        truncatedTail = true;
        break;
      }
      throw corrupt(`journal entry ${index + 1} is invalid JSON`);
    }
    validateEvent(event, { runId, sequence: index + 1, previousHash });
    if (eventIds.has(event.eventId)) throw corrupt('journal event ID is duplicated');
    if (idempotencyKeys.has(event.idempotencyKey)) throw corrupt('journal idempotency key is duplicated');
    eventIds.add(event.eventId);
    idempotencyKeys.add(event.idempotencyKey);
    runId = event.runId;
    previousHash = event.eventHash;
    events.push(event);
  }
  return { events, lastHash: previousHash, truncatedTail };
}

export function replayRunJournal(file) {
  return validateRunJournal(file).events;
}

function safeRunId(runId) {
  return requireSafeToken(runId, 'run ID');
}

export function openRunJournal(root, runId) {
  const directory = path.join(workspacePaths(root).runs, safeRunId(runId));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'journal.jsonl');
  const state = validateRunJournal(file);
  if (state.events.length && state.events[0].runId !== runId) throw corrupt('journal run ID does not match its directory');
  return { root: path.resolve(root), runId, directory, file, events: state.events, lastHash: state.lastHash };
}

function sameIdempotentInput(event, input) {
  return event.type === input.type
    && event.stageId === input.stageId
    && stableJson(event.payload) === stableJson(input.payload);
}

function appendSynced(file, bytes) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('journal append made no progress');
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function hasFinalDelimiter(file) {
  const bytes = fs.readFileSync(file);
  return bytes.length === 0 || bytes.at(-1) === 0x0a;
}

export function appendRunEvent(handle, input, lease) {
  if (!handle || typeof handle !== 'object') throw new TypeError('journal handle is required');
  if (!input || typeof input !== 'object') throw new TypeError('journal event input is required');
  const type = requireSafeToken(input.type, 'event type');
  const stageId = requireSafeToken(input.stageId, 'stage ID');
  const idempotencyKey = requireSafeToken(input.idempotencyKey, 'idempotency key');
  validatePayload(input.payload);
  const leaseId = requireSafeToken(lease?.leaseId, 'lease ID');
  if (!Number.isInteger(lease?.generation) || lease.generation < 1) throw new TypeError('journal lease generation must be a positive integer');

  const state = validateRunJournal(handle.file);
  if (state.truncatedTail) throw corrupt('journal has an unresolved truncated final entry');
  const existing = state.events.find((event) => event.idempotencyKey === idempotencyKey);
  if (existing) {
    if (sameIdempotentInput(existing, { type, stageId, payload: input.payload })) return existing;
    throw new Error(`journal idempotency key conflicts: ${idempotencyKey}`);
  }

  const event = {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
    runId: handle.runId,
    sequence: state.events.length + 1,
    eventId: randomUUID(),
    type,
    recordedAt: new Date().toISOString(),
    leaseId,
    fencingGeneration: lease.generation,
    stageId,
    idempotencyKey,
    previousHash: state.lastHash,
    payloadHash: sha256(input.payload),
    payload: input.payload,
  };
  event.eventHash = envelopeHash(event);
  if (state.events.length && !hasFinalDelimiter(handle.file)) appendSynced(handle.file, Buffer.from('\n', 'utf8'));
  appendSynced(handle.file, Buffer.from(`${stableJson(event)}\n`, 'utf8'));
  handle.events = [...state.events, event];
  handle.lastHash = event.eventHash;
  return event;
}
