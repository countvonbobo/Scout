import crypto from 'node:crypto';
import { MutationCoordinatorBusyError, withMutationCoordinator } from './mutationCoordinator.mjs';
import {
  acquireScanLease, currentLeaseOwner, LeaseLostError, releaseScanLease, renewScanLease,
  startLeaseHeartbeat,
} from './scanLease.mjs';

export class WorkspaceMutationBusyError extends Error {
  constructor() {
    super('another workspace mutation is in progress');
    this.name = 'WorkspaceMutationBusyError';
    this.reasonCode = 'mutation-busy';
  }
}

export function withWorkspaceMutationAuthority(root, {
  kind,
  phase,
  runId = `${kind}-${crypto.randomUUID()}`,
} = {}, commit) {
  if (typeof commit !== 'function') throw new TypeError('workspace mutation callback is required');
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind, runId, phase });
  if (!lease) throw new WorkspaceMutationBusyError();
  try {
    return withMutationCoordinator(root, lease, (coordinator) => {
      const controller = Object.freeze({
        coordinator,
        renew() {
          renewScanLease(lease);
        },
      });
      const result = commit(controller);
      if (result && typeof result.then === 'function') {
        throw new TypeError('workspace mutation callback must be synchronous');
      }
      controller.renew();
      return result;
    });
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof MutationCoordinatorBusyError) {
      throw new WorkspaceMutationBusyError();
    }
    throw error;
  } finally {
    try {
      releaseScanLease(lease);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    }
  }
}

export async function withWorkspaceMutationAuthorityAsync(root, {
  kind,
  phase,
  runId = `${kind}-${crypto.randomUUID()}`,
} = {}, commit) {
  if (typeof commit !== 'function') throw new TypeError('workspace mutation callback is required');
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind, runId, phase });
  if (!lease) throw new WorkspaceMutationBusyError();
  const heartbeat = startLeaseHeartbeat(lease);
  try {
    return await withMutationCoordinator(root, lease, async (coordinator) => {
      const controller = Object.freeze({
        coordinator,
        renew() { renewScanLease(lease); },
      });
      const result = await commit(controller);
      if (heartbeat.lost) throw new LeaseLostError();
      controller.renew();
      return result;
    });
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof MutationCoordinatorBusyError) {
      throw new WorkspaceMutationBusyError();
    }
    throw error;
  } finally {
    heartbeat.stop();
    try { releaseScanLease(lease); }
    catch (error) { if (!(error instanceof LeaseLostError)) throw error; }
  }
}
