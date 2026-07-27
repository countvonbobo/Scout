import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertCurrentFence, assertScanLeaseScope, synchronousFenceCallback,
} from './scanLease.mjs';

const QUEUE_SCHEMA_VERSION = 1;
const REQUESTERS = new Set(['manual', 'scheduled']);
const OUTCOMES = new Set(['succeeded', 'failed', 'skipped']);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PURPOSE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function queueFile(root) {
  return path.join(path.resolve(root), '.scout', 'scan-queue.jsonl');
}

function timestamp(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${label} must be an ISO timestamp`);
  return date;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new TypeError(`${label} has an unsupported schema`);
  }
}

function checkedRequest(input) {
  exactKeys(input, ['compatibility', 'expiresAt', 'id', 'key', 'lease', 'purpose', 'requestedAt', 'requester', 'windowAt'], 'scan queue request');
  const { lease, ...request } = input;
  exactKeys(request, ['compatibility', 'expiresAt', 'id', 'key', 'purpose', 'requestedAt', 'requester', 'windowAt'], 'scan queue request');
  if (!REQUEST_ID.test(request.id || '') || !REQUEST_KEY.test(request.key || '') || !REQUESTERS.has(request.requester)
    || !PURPOSE.test(request.purpose || '')) throw new TypeError('scan queue request contains an invalid identifier');
  exactKeys(request.compatibility, ['configFingerprint', 'profileFingerprint', 'schemaVersion'], 'scan queue compatibility');
  if (!FINGERPRINT.test(request.compatibility.profileFingerprint || '') || !FINGERPRINT.test(request.compatibility.configFingerprint || '')
    || !Number.isInteger(request.compatibility.schemaVersion) || request.compatibility.schemaVersion < 1) {
    throw new TypeError('scan queue compatibility is invalid');
  }
  const requestedAt = timestamp(request.requestedAt, 'scan queue requested time');
  const expiresAt = timestamp(request.expiresAt, 'scan queue expiry');
  if (expiresAt <= requestedAt) throw new TypeError('scan queue expiry must follow the requested time');
  if (request.requester === 'manual') {
    if (request.windowAt !== null || expiresAt.getTime() !== requestedAt.getTime() + 24 * 60 * 60 * 1000) {
      throw new TypeError('manual scan requests expire exactly 24 hours after request time');
    }
  } else {
    const windowAt = timestamp(request.windowAt, 'scheduled scan window');
    const expected = Math.min(requestedAt.getTime() + 12 * 60 * 60 * 1000, windowAt.getTime());
    if (expiresAt.getTime() !== expected) throw new TypeError('scheduled scan requests expire at the next window or after 12 hours');
  }
  return { request: structuredClone(request), lease };
}

function checkedCompatibility(input) {
  exactKeys(input, ['configFingerprint', 'profileFingerprint', 'purpose', 'schemaVersion'], 'current scan compatibility');
  if (!FINGERPRINT.test(input.profileFingerprint || '') || !FINGERPRINT.test(input.configFingerprint || '')
    || !PURPOSE.test(input.purpose || '') || !Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new TypeError('current scan compatibility is invalid');
  }
  return input;
}

function checkedOutcome(outcome) {
  if (!OUTCOMES.has(outcome)) throw new TypeError('scan queue outcome is invalid');
  return outcome;
}

function event(type, body, at = new Date().toISOString()) {
  return { schemaVersion: QUEUE_SCHEMA_VERSION, eventId: randomUUID(), type, at, ...body };
}

function checkedEvent(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.schemaVersion !== QUEUE_SCHEMA_VERSION || !REQUEST_ID.test(record.eventId || '')) {
    throw new Error('scan queue journal event is invalid');
  }
  timestamp(record.at, 'scan queue event time');
  const fields = {
    enqueue: ['at', 'eventId', 'request', 'schemaVersion', 'type'],
    deduplicated: ['at', 'eventId', 'incomingRequestId', 'requestId', 'schemaVersion', 'type'],
    'scheduled-replaced': ['at', 'eventId', 'request', 'schemaVersion', 'supersededRequestId', 'type'],
    expired: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    stale: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    'window-covered': ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    claimed: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    completed: ['at', 'eventId', 'outcome', 'requestId', 'schemaVersion', 'type'],
  };
  const expected = fields[record.type];
  if (!expected || Object.keys(record).sort().join(',') !== expected.join(',')) throw new Error('scan queue journal event has an unsupported schema');
  if (record.type === 'enqueue' || record.type === 'scheduled-replaced') {
    const { lease: ignored, request } = checkedRequest({ ...record.request, lease: {} });
    void ignored;
    return { ...record, request };
  }
  for (const field of ['requestId', 'incomingRequestId', 'successorId']) {
    if (field in record && !REQUEST_ID.test(record[field] || '')) throw new Error('scan queue journal event contains an invalid request ID');
  }
  if (record.type === 'completed') checkedOutcome(record.outcome);
  return record;
}

function appendEvent(root, record) {
  const file = queueFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'a');
  try {
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function readEvents(root) {
  const file = queueFile(root);
  if (!fs.existsSync(file)) return [];
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents || !contents.endsWith('\n')) throw new Error('scan queue journal is truncated');
  return contents.slice(0, -1).split('\n').map((line) => {
    try { return checkedEvent(JSON.parse(line)); }
    catch (error) { throw new Error(`scan queue journal is invalid: ${error.message}`); }
  });
}

function stateFromEvents(events) {
  const byId = new Map();
  const seenIds = new Set();
  for (const record of events) {
    if (record.type === 'enqueue') {
      if (seenIds.has(record.request.id)) throw new Error('scan queue journal repeats a request ID');
      seenIds.add(record.request.id);
      byId.set(record.request.id, { ...record.request, status: 'queued', enqueuedAt: record.at });
      continue;
    }
    if (record.type === 'scheduled-replaced') {
      const previous = byId.get(record.supersededRequestId);
      if (seenIds.has(record.request.id) || !previous || previous.status !== 'queued'
        || previous.requester !== 'scheduled' || record.request.requester !== 'scheduled'
        || previous.key !== record.request.key) throw new Error('scan queue scheduled replacement is invalid');
      seenIds.add(record.request.id);
      previous.status = 'superseded';
      byId.set(record.request.id, { ...record.request, status: 'queued', enqueuedAt: record.at });
      continue;
    }
    if (record.type === 'deduplicated') {
      if (!byId.has(record.requestId) || seenIds.has(record.incomingRequestId)) throw new Error('scan queue deduplication references an invalid request');
      seenIds.add(record.incomingRequestId);
      continue;
    }
    const item = byId.get(record.requestId);
    if (!item) throw new Error('scan queue event references an unknown request');
    if (record.type === 'expired') {
      if (item.status !== 'queued') throw new Error('scan queue expiry is invalid');
      item.status = 'expired';
    } else if (record.type === 'stale') {
      if (item.status !== 'queued') throw new Error('scan queue staleness is invalid');
      item.status = 'stale';
    } else if (record.type === 'window-covered') {
      if (item.status !== 'queued') throw new Error('scan queue window skip is invalid');
      item.status = 'skipped';
    } else if (record.type === 'claimed') {
      if (item.status !== 'queued') throw new Error('scan queue claim is invalid');
      item.status = 'claimed';
    } else if (record.type === 'completed') {
      if (item.status !== 'claimed') throw new Error('scan queue completion is invalid');
      item.status = record.outcome;
    }
  }
  return [...byId.values()];
}

function pending(items, compatibility, now) {
  const terminal = [];
  const completedWindows = new Set(items.filter((item) => item.status === 'succeeded' && item.windowAt).map((item) => item.windowAt));
  const activeWindows = new Set(items.filter((item) => item.status === 'claimed' && item.windowAt).map((item) => item.windowAt));
  for (const item of items) {
    if (item.status !== 'queued') continue;
    if (new Date(item.expiresAt) <= now) terminal.push({ type: 'expired', requestId: item.id });
    else if (item.compatibility.profileFingerprint !== compatibility.profileFingerprint
      || item.compatibility.configFingerprint !== compatibility.configFingerprint
      || item.purpose !== compatibility.purpose
      || item.compatibility.schemaVersion !== compatibility.schemaVersion) terminal.push({ type: 'stale', requestId: item.id });
    else if (item.requester === 'scheduled' && (completedWindows.has(item.windowAt) || activeWindows.has(item.windowAt))) {
      terminal.push({ type: 'window-covered', requestId: item.id });
    }
  }
  return terminal;
}

function ready(items) {
  const manual = items.filter((item) => item.status === 'queued' && item.requester === 'manual')
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id));
  const scheduled = items.filter((item) => item.status === 'queued' && item.requester === 'scheduled')
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt) || right.id.localeCompare(left.id));
  return [...manual, ...scheduled];
}

function fenced(root, lease, callback) {
  assertScanLeaseScope(lease, root, lease?.runId);
  return assertCurrentFence(lease, synchronousFenceCallback(callback));
}

export function projectScanQueue(root, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('queue projection time must be a date');
  const requests = stateFromEvents(readEvents(root));
  return { requests, ready: ready(requests), generatedAt: now.toISOString() };
}

export function enqueueScanRequest(root, input) {
  const { request, lease } = checkedRequest(input);
  return fenced(root, lease, () => {
    const events = readEvents(root);
    const items = stateFromEvents(events);
    const seenRequestId = events.some((record) => ((record.type === 'enqueue' || record.type === 'scheduled-replaced') && record.request.id === request.id)
      || (record.type === 'deduplicated' && record.incomingRequestId === request.id));
    if (seenRequestId) {
      const duplicate = events.find((record) => record.type === 'deduplicated' && record.incomingRequestId === request.id);
      const existing = items.find((item) => item.id === (duplicate?.requestId || request.id));
      if (!existing) throw new Error('scan queue request ID has no durable result');
      return { status: duplicate ? 'deduplicated' : 'existing', request: structuredClone(existing) };
    }
    const equivalent = items.find((item) => item.key === request.key && item.requester === request.requester && item.status === 'queued');
    if (equivalent && request.requester === 'manual') {
      appendEvent(root, event('deduplicated', { requestId: equivalent.id, incomingRequestId: request.id }));
      return { status: 'deduplicated', request: structuredClone(equivalent) };
    }
    if (equivalent && request.requester === 'scheduled') {
      const incomingWins = request.requestedAt > equivalent.requestedAt
        || (request.requestedAt === equivalent.requestedAt && request.id > equivalent.id);
      if (!incomingWins) {
        appendEvent(root, event('deduplicated', { requestId: equivalent.id, incomingRequestId: request.id }));
        return { status: 'deduplicated', request: structuredClone(equivalent) };
      }
      appendEvent(root, event('scheduled-replaced', { request, supersededRequestId: equivalent.id }));
      return { status: 'enqueued', request: structuredClone(request), superseded: equivalent.id };
    }
    appendEvent(root, event('enqueue', { request }));
    return { status: 'enqueued', request: structuredClone(request) };
  });
}

export function claimNextScanRequest(root, inputCompatibility, lease, now = new Date()) {
  const compatibility = checkedCompatibility(inputCompatibility);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('scan queue claim time must be a date');
  return fenced(root, lease, () => {
    let items = stateFromEvents(readEvents(root));
    for (const terminal of pending(items, compatibility, now)) appendEvent(root, event(terminal.type, { requestId: terminal.requestId }, now.toISOString()));
    items = stateFromEvents(readEvents(root));
    const next = ready(items)[0];
    if (!next) return null;
    appendEvent(root, event('claimed', { requestId: next.id }, now.toISOString()));
    return { ...next, status: 'claimed' };
  });
}

export function completeScanRequest(root, requestId, outcome, lease) {
  if (!REQUEST_ID.test(requestId || '')) throw new TypeError('scan queue request ID is invalid');
  checkedOutcome(outcome);
  return fenced(root, lease, () => {
    const item = stateFromEvents(readEvents(root)).find((request) => request.id === requestId);
    if (!item || item.status !== 'claimed') throw new Error('scan queue request is not claimed');
    appendEvent(root, event('completed', { requestId, outcome }));
    return { ...item, status: outcome };
  });
}
