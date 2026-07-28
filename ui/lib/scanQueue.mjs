import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendObservedScanQueueEvent, assertCurrentFence, assertScanLeaseScope, synchronousFenceCallback,
} from './scanLease.mjs';

const QUEUE_SCHEMA_VERSION = 4;
const REPLAYABLE_QUEUE_SCHEMA_VERSIONS = new Set([2, 3, QUEUE_SCHEMA_VERSION]);
const REQUESTERS = new Set(['manual', 'scheduled']);
const OUTCOMES = new Set(['succeeded', 'failed', 'skipped', 'stale']);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PURPOSE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function queueFile(root) { return path.join(path.resolve(root), '.scout', 'scan-queue.jsonl'); }

function timestamp(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${label} must be an ISO timestamp`);
  return date;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new TypeError(`${label} has an unsupported schema`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function requestDigest(request) { return createHash('sha256').update(stableJson(request)).digest('hex'); }
function sameRequest(left, right) { return stableJson(left) === stableJson(right); }

function checkedRequest(input) {
  const withExecution = Object.hasOwn(input || {}, 'execution');
  exactKeys(input, [
    'compatibility', ...(withExecution ? ['execution'] : []), 'expiresAt', 'id',
    'key', 'lease', 'purpose', 'requestedAt', 'requester', 'windowAt',
  ], 'scan queue request');
  const { lease, ...request } = input;
  exactKeys(request, [
    'compatibility', ...(withExecution ? ['execution'] : []), 'expiresAt', 'id',
    'key', 'purpose', 'requestedAt', 'requester', 'windowAt',
  ], 'scan queue request');
  if (!REQUEST_ID.test(request.id || '') || !REQUEST_KEY.test(request.key || '') || !REQUESTERS.has(request.requester) || !PURPOSE.test(request.purpose || '')) {
    throw new TypeError('scan queue request contains an invalid identifier');
  }
  exactKeys(request.compatibility, ['configFingerprint', 'profileFingerprint', 'schemaVersion'], 'scan queue compatibility');
  if (!FINGERPRINT.test(request.compatibility.profileFingerprint || '') || !FINGERPRINT.test(request.compatibility.configFingerprint || '')
    || !Number.isInteger(request.compatibility.schemaVersion) || request.compatibility.schemaVersion < 1) throw new TypeError('scan queue compatibility is invalid');
  if (withExecution) {
    const executionFields = request.execution?.schemaVersion === 2
      ? ['compatibilityFingerprint', 'logicalWindowId', 'mode', 'model', 'provider', 'scheduleId', 'schemaVersion']
      : ['mode', 'model', 'provider', 'schemaVersion'];
    exactKeys(request.execution, executionFields, 'scan queue execution');
    if (![1, 2].includes(request.execution.schemaVersion)
      || !['codex', 'claude'].includes(request.execution.provider)
      || !['primary', 'second-pass', 'broadened'].includes(request.execution.mode)
      || (request.execution.model !== null
        && (typeof request.execution.model !== 'string'
          || !/^[A-Za-z0-9._:-]{1,96}$/.test(request.execution.model)))) {
      throw new TypeError('scan queue execution is invalid');
    }
    if (request.execution.schemaVersion === 2) {
      if (!FINGERPRINT.test(request.execution.compatibilityFingerprint || '')) {
        throw new TypeError('scan queue execution compatibility is invalid');
      }
      if (request.requester === 'manual') {
        if (request.execution.scheduleId !== null || request.execution.logicalWindowId !== null) {
          throw new TypeError('manual scan execution cannot identify a schedule window');
        }
      } else {
        if (!REQUEST_KEY.test(request.execution.scheduleId || '')) {
          throw new TypeError('scheduled scan execution job is invalid');
        }
        timestamp(request.execution.logicalWindowId, 'scheduled scan logical window');
      }
    }
  }
  const requestedAt = timestamp(request.requestedAt, 'scan queue requested time');
  const expiresAt = timestamp(request.expiresAt, 'scan queue expiry');
  if (expiresAt <= requestedAt) throw new TypeError('scan queue expiry must follow the requested time');
  if (request.requester === 'manual') {
    if (request.windowAt !== null || expiresAt.getTime() !== requestedAt.getTime() + 24 * 60 * 60 * 1000) throw new TypeError('manual scan requests expire exactly 24 hours after request time');
  } else {
    const windowAt = timestamp(request.windowAt, 'scheduled scan window');
    if (expiresAt.getTime() !== Math.min(requestedAt.getTime() + 12 * 60 * 60 * 1000, windowAt.getTime())) throw new TypeError('scheduled scan requests expire at the next window or after 12 hours');
  }
  return { request: structuredClone(request), lease };
}

function checkedCompatibility(input) {
  exactKeys(input, ['configFingerprint', 'profileFingerprint', 'purpose', 'schemaVersion'], 'current scan compatibility');
  if (!FINGERPRINT.test(input.profileFingerprint || '') || !FINGERPRINT.test(input.configFingerprint || '') || !PURPOSE.test(input.purpose || '')
    || !Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) throw new TypeError('current scan compatibility is invalid');
  return input;
}

function checkedOutcome(outcome) { if (!OUTCOMES.has(outcome)) throw new TypeError('scan queue outcome is invalid'); return outcome; }

function checkedClaim(claim) {
  exactKeys(claim, ['claimId', 'generation', 'leaseId', 'owner', 'runId'], 'scan queue claim');
  exactKeys(claim.owner, ['host', 'pid', 'processStart'], 'scan queue claim owner');
  if (!REQUEST_ID.test(claim.claimId || '') || !REQUEST_KEY.test(claim.leaseId || '') || !REQUEST_ID.test(claim.runId || '')
    || !Number.isSafeInteger(claim.generation) || claim.generation < 1 || typeof claim.owner.host !== 'string' || !claim.owner.host || claim.owner.host.length > 255
    || !Number.isSafeInteger(claim.owner.pid) || claim.owner.pid < 1 || !REQUEST_KEY.test(claim.owner.processStart || '')) throw new TypeError('scan queue claim is invalid');
  return structuredClone(claim);
}

function claimForLease(lease, claimId = randomUUID()) {
  return checkedClaim({ claimId, leaseId: lease?.leaseId, generation: lease?.generation, runId: lease?.runId, owner: lease?.owner });
}

function sameClaim(left, right) {
  return left?.claimId === right?.claimId && left?.leaseId === right?.leaseId && left?.generation === right?.generation
    && left?.runId === right?.runId && left?.owner?.host === right?.owner?.host && left?.owner?.pid === right?.owner?.pid
    && left?.owner?.processStart === right?.owner?.processStart;
}

function sameClaimFence(claim, lease) {
  const current = claimForLease(lease, claim?.claimId);
  return sameClaim(claim, current);
}

function event(type, body, at = new Date().toISOString()) { return { schemaVersion: QUEUE_SCHEMA_VERSION, eventId: randomUUID(), type, at, ...body }; }

function eventRequest(record) {
  const { lease: ignored, request } = checkedRequest({ ...record.request, lease: {} });
  void ignored;
  if (!FINGERPRINT.test(record.requestDigest || '') || record.requestDigest !== requestDigest(request)) throw new Error('scan queue event request digest is invalid');
  return request;
}

function checkedEvent(record) {
  if (record?.schemaVersion === 1) return checkedLegacyEvent(record);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !REPLAYABLE_QUEUE_SCHEMA_VERSIONS.has(record.schemaVersion)
    || !REQUEST_ID.test(record.eventId || '')) throw new Error('scan queue journal event is invalid');
  timestamp(record.at, 'scan queue event time');
  const fields = {
    enqueue: ['at', 'eventId', 'request', 'requestDigest', 'schemaVersion', 'type'],
    deduplicated: ['at', 'eventId', 'request', 'requestDigest', 'requestId', 'schemaVersion', 'type'],
    'scheduled-replaced': ['at', 'eventId', 'request', 'requestDigest', 'schemaVersion', 'supersededRequestId', 'type'],
    expired: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'], stale: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    'window-covered': ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    claimed: ['at', 'claim', 'eventId', 'requestId', 'schemaVersion', 'type'],
    'claim-recovered': ['at', 'claimId', 'eventId', 'requestId', 'schemaVersion', 'type'],
    completed: ['at', 'claimId', 'eventId', 'outcome', 'requestId', 'schemaVersion', 'type'],
  };
  const expected = fields[record.type];
  if (!expected || Object.keys(record).sort().join(',') !== expected.join(',')) throw new Error('scan queue journal event has an unsupported schema');
  if (['enqueue', 'deduplicated', 'scheduled-replaced'].includes(record.type)) {
    const checked = eventRequest(record);
    if (record.schemaVersion === 2 && checked.execution !== undefined) {
      throw new Error('version-two scan queue request contains unsupported execution metadata');
    }
    if (record.schemaVersion === 3 && checked.execution?.schemaVersion === 2) {
      throw new Error('version-three scan queue request contains unsupported execution metadata');
    }
    return { ...record, request: checked };
  }
  if (!REQUEST_ID.test(record.requestId || '')) throw new Error('scan queue journal event contains an invalid request ID');
  if (record.type === 'claimed') return { ...record, claim: checkedClaim(record.claim) };
  if (record.type === 'claim-recovered' && !REQUEST_ID.test(record.claimId || '')) throw new Error('scan queue recovery event is invalid');
  if (record.type === 'completed') { if (!REQUEST_ID.test(record.claimId || '')) throw new Error('scan queue completion claim is invalid'); checkedOutcome(record.outcome); }
  return record;
}

function checkedLegacyEvent(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !REQUEST_ID.test(record.eventId || '')) throw new Error('legacy scan queue journal event is invalid');
  timestamp(record.at, 'legacy scan queue event time');
  const fields = {
    enqueue: ['at', 'eventId', 'request', 'schemaVersion', 'type'],
    deduplicated: ['at', 'eventId', 'incomingRequestId', 'requestId', 'schemaVersion', 'type'],
    'scheduled-replaced': ['at', 'eventId', 'request', 'schemaVersion', 'supersededRequestId', 'type'],
    expired: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'], stale: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    'window-covered': ['at', 'eventId', 'requestId', 'schemaVersion', 'type'], claimed: ['at', 'eventId', 'requestId', 'schemaVersion', 'type'],
    completed: ['at', 'eventId', 'outcome', 'requestId', 'schemaVersion', 'type'],
  };
  const expected = fields[record.type];
  if (!expected || Object.keys(record).sort().join(',') !== expected.join(',')) throw new Error('legacy scan queue journal event has an unsupported schema');
  if (record.type === 'enqueue' || record.type === 'scheduled-replaced') {
    if (Object.hasOwn(record.request || {}, 'execution')) {
      throw new Error('legacy scan queue request contains unsupported execution metadata');
    }
    const { lease: ignored, request } = checkedRequest({ ...record.request, lease: {} }); void ignored; return { ...record, request, legacy: true };
  }
  for (const field of ['requestId', 'incomingRequestId', 'supersededRequestId']) if (field in record && !REQUEST_ID.test(record[field] || '')) throw new Error('legacy scan queue journal request ID is invalid');
  if (record.type === 'completed') checkedOutcome(record.outcome);
  return { ...record, legacy: true };
}

function appendEvent(root, record) {
  const file = queueFile(root); fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'a');
  try { fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function eventsFromContents(contents) {
  if (!contents) return [];
  if (!contents.endsWith('\n')) throw new Error('scan queue journal is truncated');
  return contents.slice(0, -1).split('\n').map((line) => { try { return checkedEvent(JSON.parse(line)); } catch (error) { throw new Error(`scan queue journal is invalid: ${error.message}`); } });
}

function queueSnapshot(root) {
  const file = queueFile(root);
  const contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return {
    digest: createHash('sha256').update(contents).digest('hex'),
    events: eventsFromContents(contents),
  };
}

function readEvents(root) {
  return queueSnapshot(root).events;
}

function newerScheduled(incoming, previous) { return incoming.requestedAt > previous.requestedAt || (incoming.requestedAt === previous.requestedAt && incoming.id > previous.id); }

function sameExecutionContract(left, right) {
  return left.requester === right.requester && left.key === right.key && left.purpose === right.purpose
    && left.compatibility.profileFingerprint === right.compatibility.profileFingerprint
    && left.compatibility.configFingerprint === right.compatibility.configFingerprint
    && left.compatibility.schemaVersion === right.compatibility.schemaVersion
    && stableJson(left.execution ?? null) === stableJson(right.execution ?? null);
}

function stateFromEvents(events) {
  const byId = new Map(); const inputs = new Map(); const aliases = new Map(); const eventIds = new Set(); const claimIds = new Set();
  for (const record of events) {
    if (eventIds.has(record.eventId)) throw new Error('scan queue journal repeats an event ID');
    eventIds.add(record.eventId);
    if (record.type === 'enqueue') {
      if (inputs.has(record.request.id)) throw new Error('scan queue journal repeats a request ID');
      inputs.set(record.request.id, record.request); byId.set(record.request.id, { ...record.request, status: 'queued', enqueuedAt: record.at, claim: null, completion: null }); continue;
    }
    if (record.type === 'scheduled-replaced') {
      const previous = byId.get(record.supersededRequestId);
      const equivalent = record.legacy
        ? previous?.requester === record.request.requester && previous?.key === record.request.key
        : sameExecutionContract(previous, record.request);
      if (inputs.has(record.request.id) || !previous || previous.status !== 'queued' || previous.requester !== 'scheduled'
        || record.request.requester !== 'scheduled' || !equivalent || !newerScheduled(record.request, previous)) throw new Error('scan queue scheduled replacement is invalid');
      inputs.set(record.request.id, record.request); previous.status = 'superseded'; byId.set(record.request.id, { ...record.request, status: 'queued', enqueuedAt: record.at, claim: null, completion: null }); continue;
    }
    if (record.type === 'deduplicated') {
      const target = byId.get(record.requestId);
      if (record.legacy) {
        if (!target || target.status !== 'queued' || inputs.has(record.incomingRequestId)) throw new Error('legacy scan queue deduplication references an invalid request');
        inputs.set(record.incomingRequestId, null); aliases.set(record.incomingRequestId, target.id); continue;
      }
      if (inputs.has(record.request.id) || !target || target.status !== 'queued' || !sameExecutionContract(target, record.request)) throw new Error('scan queue deduplication references an invalid request');
      inputs.set(record.request.id, record.request); aliases.set(record.request.id, target.id); continue;
    }
    const item = byId.get(record.requestId); if (!item) throw new Error('scan queue event references an unknown request');
    if (record.type === 'expired' || record.type === 'stale' || record.type === 'window-covered') {
      if (item.status !== 'queued') throw new Error('scan queue terminal transition is invalid'); item.status = record.type === 'window-covered' ? 'skipped' : record.type;
    } else if (record.type === 'claimed') {
      if (item.status !== 'queued') throw new Error('scan queue claim is invalid');
      if (record.legacy) { item.status = 'legacy-claimed'; item.claim = null; }
      else { if (claimIds.has(record.claim.claimId)) throw new Error('scan queue journal repeats a claim ID'); claimIds.add(record.claim.claimId); item.status = 'claimed'; item.claim = record.claim; }
    } else if (record.type === 'claim-recovered') {
      if (item.status !== 'claimed' || item.claim?.claimId !== record.claimId) throw new Error('scan queue claim recovery is invalid'); item.status = 'queued'; item.claim = null;
    } else if (record.type === 'completed') {
      if (record.legacy) { if (item.status !== 'legacy-claimed') throw new Error('legacy scan queue completion is invalid'); item.status = record.outcome; item.completion = { claimId: null, outcome: record.outcome }; }
      else { if (item.status !== 'claimed' || item.claim?.claimId !== record.claimId) throw new Error('scan queue completion is invalid'); item.status = record.outcome; item.completion = { claimId: record.claimId, outcome: record.outcome }; }
    }
  }
  return { items: [...byId.values()], inputs, aliases };
}

function windowKey(item) {
  return item.windowAt && [
    item.execution?.scheduleId || '',
    item.execution?.logicalWindowId || item.windowAt,
    item.compatibility.profileFingerprint,
    item.compatibility.configFingerprint,
    item.purpose,
    item.compatibility.schemaVersion,
  ].join('|');
}
function pending(items, compatibility, now) {
  const terminal = []; const completedWindows = new Set(items.filter((item) => item.status === 'succeeded' && item.windowAt).map(windowKey));
  for (const item of items) {
    if (item.status !== 'queued') continue;
    if (new Date(item.expiresAt) <= now) terminal.push({ type: 'expired', requestId: item.id });
    else if (item.compatibility.profileFingerprint !== compatibility.profileFingerprint || item.compatibility.configFingerprint !== compatibility.configFingerprint || item.purpose !== compatibility.purpose || item.compatibility.schemaVersion !== compatibility.schemaVersion) terminal.push({ type: 'stale', requestId: item.id });
    else if (item.requester === 'scheduled' && completedWindows.has(windowKey(item))) terminal.push({ type: 'window-covered', requestId: item.id });
  }
  return terminal;
}

function ready(items) {
  const manual = items.filter((item) => item.status === 'queued' && item.requester === 'manual').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
  const scheduled = items.filter((item) => item.status === 'queued' && item.requester === 'scheduled').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id));
  return [...manual, ...scheduled];
}

function fenced(root, lease, callback) { assertScanLeaseScope(lease, root, lease?.runId); return assertCurrentFence(lease, synchronousFenceCallback(callback)); }
function publicItem(item) { return structuredClone(item); }

export function projectScanQueue(root, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('queue projection time must be a date');
  const { items } = stateFromEvents(readEvents(root)); return { requests: items.map(publicItem), ready: ready(items).map(publicItem), generatedAt: now.toISOString() };
}

export function enqueueScanRequest(root, input) {
  const { request, lease } = checkedRequest(input); const digest = requestDigest(request);
  return fenced(root, lease, () => appendEnqueueTransition(root, request, digest));
}

export function coverScheduledScanWindow(root, input, lease) {
  exactKeys(
    input,
    ['compatibilityFingerprint', 'logicalWindowId', 'purpose', 'scheduleId'],
    'scheduled scan window coverage',
  );
  if (!REQUEST_KEY.test(input.scheduleId || '')
    || !PURPOSE.test(input.purpose || '')
    || !FINGERPRINT.test(input.compatibilityFingerprint || '')) {
    throw new TypeError('scheduled scan window coverage contains an invalid identifier');
  }
  timestamp(input.logicalWindowId, 'scheduled scan coverage logical window');
  return fenced(root, lease, () => {
    const matches = stateFromEvents(readEvents(root)).items.filter((item) => (
      item.status === 'queued'
      && item.requester === 'scheduled'
      && item.purpose === input.purpose
      && item.execution?.schemaVersion === 2
      && item.execution.scheduleId === input.scheduleId
      && item.execution.logicalWindowId === input.logicalWindowId
      && item.execution.compatibilityFingerprint === input.compatibilityFingerprint
    ));
    for (const item of matches) {
      appendEvent(root, event('window-covered', { requestId: item.id }));
    }
    return matches.map((item) => publicItem({ ...item, status: 'skipped' }));
  });
}

function appendEnqueueTransition(root, request, digest = requestDigest(request)) {
  const transition = enqueueTransition(readEvents(root), request, digest);
  if (transition.record) appendEvent(root, transition.record);
  return transition.result;
}

function enqueueTransition(events, request, digest = requestDigest(request)) {
  const state = stateFromEvents(events);
  if (state.inputs.has(request.id)) {
    if (!sameRequest(state.inputs.get(request.id), request)) throw new Error('scan queue request ID conflicts with its durable payload');
    const target = state.aliases.get(request.id) || request.id; const existing = state.items.find((item) => item.id === target);
    if (!existing) throw new Error('scan queue request ID has no durable result');
    return { record: null, result: { status: state.aliases.has(request.id) ? 'deduplicated' : 'existing', request: publicItem(existing) } };
  }
  const equivalent = state.items.find((item) => item.status === 'queued' && sameExecutionContract(item, request));
  if (equivalent && request.requester === 'manual') {
    return {
      record: event('deduplicated', { request, requestDigest: digest, requestId: equivalent.id }),
      result: { status: 'deduplicated', request: publicItem(equivalent) },
    };
  }
  if (equivalent && request.requester === 'scheduled') {
    if (!newerScheduled(request, equivalent)) {
      return {
        record: event('deduplicated', { request, requestDigest: digest, requestId: equivalent.id }),
        result: { status: 'deduplicated', request: publicItem(equivalent) },
      };
    }
    return {
      record: event('scheduled-replaced', { request, requestDigest: digest, supersededRequestId: equivalent.id }),
      result: { status: 'enqueued', request: structuredClone(request), superseded: equivalent.id },
    };
  }
  return {
    record: event('enqueue', { request, requestDigest: digest }),
    result: { status: 'enqueued', request: structuredClone(request) },
  };
}

export function enqueueOverlappingScanRequest(root, input, options = {}) {
  const withExecution = Object.hasOwn(input || {}, 'execution');
  exactKeys(input, [
    'compatibility', ...(withExecution ? ['execution'] : []), 'expiresAt', 'id',
    'key', 'observedLease', 'purpose',
    'requestedAt', 'requester', 'windowAt',
  ], 'overlapping scan queue request');
  const { observedLease, ...payload } = input;
  const { request } = checkedRequest({ ...payload, lease: {} });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const snapshot = queueSnapshot(root);
    const transition = enqueueTransition(snapshot.events, request);
    if (!transition.record) return transition.result;
    const committed = appendObservedScanQueueEvent(root, observedLease, {
      expectedDigest: snapshot.digest,
      record: transition.record,
    }, options);
    if (!committed.active) return Object.freeze({ status: 'not-active', request: null });
    if (committed.appended) return transition.result;
  }
  throw new Error('scan queue changed repeatedly during overlap append');
}

export function claimNextScanRequest(root, inputCompatibility, lease, now = new Date()) {
  const compatibility = checkedCompatibility(inputCompatibility); if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('scan queue claim time must be a date');
  return fenced(root, lease, () => {
    let state = stateFromEvents(readEvents(root)); const ownClaim = state.items.find((item) => item.status === 'claimed' && sameClaimFence(item.claim, lease));
    if (ownClaim) return publicItem(ownClaim);
    if (state.items.some((item) => item.status === 'legacy-claimed')) throw new Error('legacy scan queue claim requires operator recovery before draining');
    if (state.items.some((item) => item.status === 'claimed')) throw new Error('orphaned scan queue claim requires explicit fenced recovery');
    for (const terminal of pending(state.items, compatibility, now)) appendEvent(root, event(terminal.type, { requestId: terminal.requestId }, now.toISOString()));
    state = stateFromEvents(readEvents(root)); const next = ready(state.items)[0]; if (!next) return null;
    const claim = claimForLease(lease); appendEvent(root, event('claimed', { requestId: next.id, claim }, now.toISOString())); return publicItem({ ...next, status: 'claimed', claim });
  });
}

export function completeScanRequest(root, requestId, outcome, lease, claim) {
  if (!REQUEST_ID.test(requestId || '')) throw new TypeError('scan queue request ID is invalid'); checkedOutcome(outcome); claim = checkedClaim(claim);
  return fenced(root, lease, () => {
    if (!sameClaimFence(claim, lease)) throw new Error('scan queue completion claim does not belong to this lease');
    const item = stateFromEvents(readEvents(root)).items.find((request) => request.id === requestId); if (!item) throw new Error('scan queue request is unknown');
    if (item.completion) { if (item.completion.claimId !== claim.claimId || item.completion.outcome !== outcome) throw new Error('scan queue completion conflicts with its durable outcome'); return publicItem(item); }
    if (item.status !== 'claimed' || !sameClaim(item.claim, claim)) throw new Error('scan queue completion does not own the claim');
    appendEvent(root, event('completed', { requestId, claimId: claim.claimId, outcome })); return publicItem({ ...item, status: outcome, completion: { claimId: claim.claimId, outcome } });
  });
}

export function recoverOrphanedScanRequest(root, requestId, claim, lease) {
  if (!REQUEST_ID.test(requestId || '')) throw new TypeError('scan queue request ID is invalid'); claim = checkedClaim(claim);
  return fenced(root, lease, () => {
    if (sameClaimFence(claim, lease)) throw new Error('scan queue claim is still owned by this lease');
    const item = stateFromEvents(readEvents(root)).items.find((request) => request.id === requestId);
    if (!item || item.status !== 'claimed' || !sameClaim(item.claim, claim)) throw new Error('scan queue orphan recovery does not match the durable claim');
    appendEvent(root, event('claim-recovered', { requestId, claimId: claim.claimId })); return publicItem({ ...item, status: 'queued', claim: null });
  });
}

export function completeOrphanedScanRequest(root, requestId, outcome, claim, lease) {
  if (!REQUEST_ID.test(requestId || '')) throw new TypeError('scan queue request ID is invalid');
  checkedOutcome(outcome);
  claim = checkedClaim(claim);
  return fenced(root, lease, () => {
    if (sameClaimFence(claim, lease)) throw new Error('scan queue claim is not orphaned');
    const item = stateFromEvents(readEvents(root)).items.find((request) => request.id === requestId);
    if (!item || item.status !== 'claimed' || !sameClaim(item.claim, claim)) {
      throw new Error('scan queue orphan completion does not match the durable claim');
    }
    appendEvent(root, event('completed', {
      requestId,
      claimId: claim.claimId,
      outcome,
    }));
    return publicItem({
      ...item,
      status: outcome,
      completion: { claimId: claim.claimId, outcome },
    });
  });
}
