import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { acquireScanLock, releaseScanLock } from '../../tools/scan-lock.mjs';
import { atomicWriteFile } from './atomicWrite.mjs';

export class TrackerRevisionConflictError extends Error {
  constructor(currentRevision) {
    super('The tracker changed since this page was loaded');
    this.name = 'TrackerRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export function trackerRevision(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function readTrackerSnapshot(file) {
  const content = fs.readFileSync(file, 'utf8');
  try {
    return { data: JSON.parse(content), revision: trackerRevision(content) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      error.message = `The tracker file is corrupted but your data is likely intact. A backup is available in the workspace backup repository. Error: ${error.message}`;
    }
    throw error;
  }
}

export function atomicReplaceTracker(file, content) {
  atomicWriteFile(file, content);
}

export async function acquireTrackerMutationLock(workspaceRoot, {
  timeoutMs = 5000,
  pollMs = 25,
  token = randomUUID(),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = acquireScanLock(workspaceRoot, { agent: 'scout-ui', mode: 'tracker-mutation', token });
    if (result.ok) return result.lock;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function releaseTrackerMutationLock(workspaceRoot, token) {
  return releaseScanLock(workspaceRoot, token);
}

export function mutateTrackerSnapshot(file, mutate, serialize, { expectedRevision } = {}) {
  const current = readTrackerSnapshot(file);
  if (expectedRevision && expectedRevision !== current.revision) {
    throw new TrackerRevisionConflictError(current.revision);
  }
  const next = mutate(current.data);
  const content = serialize(next);
  JSON.parse(content);
  atomicReplaceTracker(file, content);
  return { data: next, revision: trackerRevision(content) };
}
