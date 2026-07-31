import fs from 'node:fs';
import path from 'node:path';
import {
  MutationConflictError, applyPreparedMutation, loadPreparedMutation,
  prepareMutation, reconcileMutation,
} from './mutationCoordinator.mjs';
import { jsonReplaceRecipe } from './scanMutationProjection.mjs';
import {
  acquireScanLease, currentLeaseOwner, releaseScanLease,
} from './scanLease.mjs';
import { openRunJournal, replayRunJournal } from './runJournal.mjs';
import { workspacePaths } from './workspace.mjs';

export const PROFILE_PUBLICATION_RUN_PREFIX = 'search-plan-publish-';
const PROFILE_PUBLICATION_TARGET = Object.freeze({
  id: 'search-profile-publication',
  schemaVersion: 1,
  files: Object.freeze([
    Object.freeze({ kind: 'json', key: 'search-profile' }),
    Object.freeze({ kind: 'json', key: 'search-lanes' }),
    Object.freeze({ kind: 'json', key: 'employers' }),
    Object.freeze({ kind: 'json', key: 'workspace-config' }),
  ]),
});
const PROFILE_PUBLICATION_KEYS = Object.freeze([
  'search-profile', 'search-lanes', 'employers', 'workspace-config',
]);

function publicationHandle(context) {
  if (!context?.root || !context?.runId || !context?.lease) {
    throw new TypeError('profile publication requires a workspace, run ID and lease');
  }
  if (!context.runId.startsWith(PROFILE_PUBLICATION_RUN_PREFIX)) {
    throw new TypeError('profile publication run ID is not recoverable');
  }
  return context.handle ?? openRunJournal(context.root, context.runId);
}

function publicationRecipes(generation) {
  if (!generation || Object.getPrototypeOf(generation) !== Object.prototype
    || Object.keys(generation).sort().join(',') !== 'config,employers,lanes,profile') {
    throw new TypeError('profile publication generation is invalid');
  }
  const durableJson = (value) => JSON.parse(JSON.stringify(value));
  return {
    'search-profile': jsonReplaceRecipe(durableJson(generation.profile)),
    'search-lanes': jsonReplaceRecipe(durableJson(generation.lanes)),
    employers: jsonReplaceRecipe(durableJson(generation.employers)),
    'workspace-config': jsonReplaceRecipe(durableJson(generation.config)),
  };
}

export function publishProfileGeneration(context, generation, hooks = {}) {
  const handle = publicationHandle(context);
  const plan = prepareMutation({ handle, lease: context.lease }, PROFILE_PUBLICATION_TARGET, publicationRecipes(generation));
  return applyPreparedMutation(plan, context.lease, hooks);
}

function assertPublicationPlan(plan) {
  if (plan.target?.id !== PROFILE_PUBLICATION_TARGET.id
    || plan.target?.schemaVersion !== PROFILE_PUBLICATION_TARGET.schemaVersion
    || plan.files.map(({ key }) => key).join(',') !== PROFILE_PUBLICATION_KEYS.join(',')
    || plan.files.some((file) => file.kind !== 'json')) {
    throw new MutationConflictError('prepared search-plan publication target is invalid');
  }
  return plan;
}

function publicationCandidates(root) {
  const runs = workspacePaths(root).runs;
  let entries;
  try {
    entries = fs.readdirSync(runs, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(({ name }) => name.startsWith(PROFILE_PUBLICATION_RUN_PREFIX))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new MutationConflictError(`profile publication run is not a physical directory: ${entry.name}`);
      }
      const handle = openRunJournal(root, entry.name);
      const events = replayRunJournal(handle.file);
      const prepared = events.filter((event) => event.type === 'mutation.prepared');
      if (!prepared.length) return null;
      if (prepared.length !== 1
        || prepared[0].payload?.reference?.kind !== 'mutation') {
        throw new MutationConflictError(`profile publication journal is ambiguous: ${entry.name}`);
      }
      const receipts = events.filter((event) => event.type === 'mutation.receipted');
      const plan = assertPublicationPlan(loadPreparedMutation(
        handle,
        prepared[0].payload.reference.id,
      ));
      if (receipts.length > 1 || receipts.some((event) => (
        event.payload?.reference?.kind !== 'mutation'
        || event.payload.reference.id !== plan.mutationId
        || event.payload.digest !== plan.receiptDigest
      ))) {
        throw new MutationConflictError(`profile publication receipt is ambiguous: ${entry.name}`);
      }
      return {
        handle,
        plan,
        completed: receipts.length === 1,
      };
    })
    .filter(Boolean);
}

export function recoverPendingProfilePublications(root, { hooks = {} } = {}) {
  const candidates = publicationCandidates(root);
  const pending = candidates.filter(({ plan, completed }) => (
    !completed && reconcileMutation(plan).status !== 'receipted'
  ));
  if (pending.length > 1) {
    throw new MutationConflictError('multiple unfinished profile publications are ambiguous');
  }
  if (!pending.length) return [];

  const [{ handle, plan }] = pending;
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'search-plan-mutation',
    runId: handle.runId,
    phase: 'publish-recovery',
  });
  if (!lease) {
    const error = new MutationConflictError(
      'unfinished profile publication is still fenced by another operation',
    );
    error.reasonCode = 'profile-publication-fenced';
    throw error;
  }
  try {
    const receipt = applyPreparedMutation(plan, lease, hooks);
    return [Object.freeze({ runId: handle.runId, mutationId: plan.mutationId, receipt })];
  } finally {
    releaseScanLease(lease);
  }
}
