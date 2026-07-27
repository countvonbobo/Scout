import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workspacePaths } from './workspace.mjs';

export const RUN_JOURNAL_SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 16 * 1024;

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

function validatePayload(payload, ErrorType = TypeError) {
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
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const opening = stack.pop();
      if ((character === '}' && opening !== '{') || (character === ']' && opening !== '[')) return false;
    }
  }
  return inString || stack.length > 0;
}

function corrupt(message) {
  return new JournalCorruptionError(message);
}

function validateEvent(event, { runId, sequence, previousHash }) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw corrupt('journal event must be an object');
  if (event.schemaVersion !== RUN_JOURNAL_SCHEMA_VERSION) throw corrupt(`unsupported journal schema version: ${event.schemaVersion}`);
  if (runId !== null && event.runId !== runId) throw corrupt('journal run ID changed');
  requireText(event.runId, 'run ID', JournalCorruptionError);
  if (event.sequence !== sequence) throw corrupt(`journal sequence must be ${sequence}`);
  requireText(event.eventId, 'event ID', JournalCorruptionError);
  requireText(event.type, 'event type', JournalCorruptionError);
  requireText(event.stageId, 'stage ID', JournalCorruptionError);
  requireText(event.idempotencyKey, 'idempotency key', JournalCorruptionError);
  requireText(event.leaseId, 'lease ID', JournalCorruptionError);
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
  requireText(runId, 'run ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new TypeError('journal run ID is invalid');
  return runId;
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

export function appendRunEvent(handle, input, lease) {
  if (!handle || typeof handle !== 'object') throw new TypeError('journal handle is required');
  if (!input || typeof input !== 'object') throw new TypeError('journal event input is required');
  const type = requireText(input.type, 'event type');
  const stageId = requireText(input.stageId, 'stage ID');
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotency key');
  validatePayload(input.payload);
  const leaseId = requireText(lease?.leaseId, 'lease ID');
  if (!Number.isInteger(lease?.generation) || lease.generation < 1) throw new TypeError('journal lease generation must be a positive integer');

  const state = validateRunJournal(handle.file);
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
  const descriptor = fs.openSync(handle.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try {
    const bytes = Buffer.from(`${stableJson(event)}\n`, 'utf8');
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
  handle.events = [...state.events, event];
  handle.lastHash = event.eventHash;
  return event;
}
