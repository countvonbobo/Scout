import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  publishProfileGeneration, recoverPendingProfilePublications,
} from './profilePublication.mjs';
import {
  acquireScanLease, currentLeaseOwner, releaseScanLease,
} from './scanLease.mjs';
import { replayRunJournal } from './runJournal.mjs';
import {
  draftProfileFromLegacy, publishSearchProfile,
} from './searchProfile.mjs';
import {
  loadSearchLanePlan, reconcileSearchLanePlan,
} from './searchLanes.mjs';
import {
  loadEmployerRegistry, migrateLegacyPortals, reconcileEmployerDiscoveries,
} from './employerRegistry.mjs';
import {
  loadWorkspaceConfig, seedWorkspace, writeWorkspaceConfig,
} from './workspace.mjs';
import { rerankHistoricalVacancies } from './workspaceMigration.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(index) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `scout-profile-publication-${index}-`));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'profile', 'search'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'search', 'published.json'), '{"id":"profile-old"}\n');
  fs.writeFileSync(path.join(root, 'data', 'search-lanes.json'), '{"generation":1,"lanes":[]}\n');
  fs.writeFileSync(path.join(root, 'data', 'employers.json'), '{"revision":1,"employers":[]}\n');
  fs.writeFileSync(path.join(root, 'workspace.json'), '{"version":1,"searchProfile":{"publishedId":"profile-old"}}\n');
  const runId = `search-plan-publish-crash-${index}`;
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'search-plan-mutation',
    runId,
    phase: 'publish',
  });
  assert.ok(lease);
  return { root, runId, lease };
}

function generation(index) {
  return {
    profile: { id: `profile-new-${index}`, status: 'published' },
    lanes: { generation: 2, profileId: `profile-new-${index}`, lanes: [{ id: 'lane-one' }] },
    employers: { revision: 2, profileId: `profile-new-${index}`, employers: [{ id: 'example' }] },
    config: { version: 1, searchProfile: { publishedId: `profile-new-${index}` } },
  };
}

function cleanJson(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete value._scoutMutation;
  return value;
}

test('profile publication recovers coherently after every individual replacement window', () => {
  const keys = ['search-profile', 'search-lanes', 'employers', 'workspace-config'];
  for (let crashAfter = 1; crashAfter <= keys.length; crashAfter += 1) {
    const { root, runId, lease } = fixture(crashAfter);
    const intended = generation(crashAfter);
    let replacements = 0;
    assert.throws(
      () => publishProfileGeneration(
        { root, runId, lease },
        intended,
        {
          afterReplacement() {
            replacements += 1;
            if (replacements === crashAfter) throw new Error(`crash-after-${crashAfter}`);
          },
        },
      ),
      new RegExp(`crash-after-${crashAfter}`),
    );
    releaseScanLease(lease);

    const resumed = [];
    const recovered = recoverPendingProfilePublications(root, {
      hooks: {
        beforeReplacement(target) {
          resumed.push(target.key);
        },
      },
    });

    assert.deepEqual(resumed, keys.slice(crashAfter));
    assert.deepEqual(recovered.map((entry) => entry.runId), [runId]);
    assert.deepEqual(cleanJson(path.join(root, 'profile', 'search', 'published.json')), intended.profile);
    assert.deepEqual(cleanJson(path.join(root, 'data', 'search-lanes.json')), intended.lanes);
    assert.deepEqual(cleanJson(path.join(root, 'data', 'employers.json')), intended.employers);
    assert.deepEqual(cleanJson(path.join(root, 'workspace.json')), intended.config);

    const events = replayRunJournal(path.join(root, '.scout', 'runs', runId, 'journal.jsonl'));
    assert.deepEqual(events.map(({ type }) => type), ['mutation.prepared', 'mutation.receipted']);
  }
});

test('unfinished publication under a live fence exposes a retryable recovery reason', () => {
  const { root, runId, lease } = fixture('busy-recovery');
  assert.throws(() => publishProfileGeneration(
    { root, runId, lease },
    generation('busy-recovery'),
    {
      afterReplacement() {
        throw new Error('crash-with-live-fence');
      },
    },
  ), /crash-with-live-fence/);
  assert.throws(
    () => recoverPendingProfilePublications(root),
    (error) => error?.reasonCode === 'profile-publication-fenced',
  );
  releaseScanLease(lease);
  assert.equal(recoverPendingProfilePublications(root).length, 1);
});

test('profile publication recovery fails closed when pending state conflicts', () => {
  const { root, lease } = fixture('conflict');
  assert.throws(
    () => publishProfileGeneration(
      { root, runId: 'search-plan-publish-crash-conflict', lease },
      generation('conflict'),
      {
        afterReplacement() {
          throw new Error('crash-after-first');
        },
      },
    ),
    /crash-after-first/,
  );
  releaseScanLease(lease);
  fs.writeFileSync(path.join(root, 'data', 'search-lanes.json'), '{"operatorEdit":true}\n');

  assert.throws(
    () => recoverPendingProfilePublications(root),
    /conflict|revision/i,
  );
  assert.deepEqual(cleanJson(path.join(root, 'profile', 'search', 'published.json')), {
    id: 'profile-new-conflict',
    status: 'published',
  });
  assert.deepEqual(cleanJson(path.join(root, 'data', 'search-lanes.json')), { operatorEdit: true });
});

test('completed older publications remain valid after a newer generation replaces their targets', () => {
  const { root, lease } = fixture('successive');
  publishProfileGeneration(
    { root, runId: 'search-plan-publish-crash-successive', lease },
    generation('first'),
  );
  releaseScanLease(lease);

  const nextRunId = 'search-plan-publish-successive-next';
  const nextLease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'search-plan-mutation',
    runId: nextRunId,
    phase: 'publish',
  });
  assert.ok(nextLease);
  publishProfileGeneration(
    { root, runId: nextRunId, lease: nextLease },
    generation('second'),
  );
  releaseScanLease(nextLease);

  assert.deepEqual(recoverPendingProfilePublications(root), []);
  assert.deepEqual(cleanJson(path.join(root, 'profile', 'search', 'published.json')), {
    id: 'profile-new-second',
    status: 'published',
  });
});

test('profile publication accepts the production-shaped migrated generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-profile-publication-shaped-'));
  roots.push(root);
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  seedWorkspace(appRoot, root);
  fs.writeFileSync(path.join(root, 'cv', 'master-cv.md'), 'PRIVATE-CV-BODY-MUST-NOT-BE-JOURNALLED\n');
  fs.writeFileSync(path.join(root, 'data', 'provider-response.txt'), 'RAW-PROVIDER-RESPONSE-MUST-NOT-BE-JOURNALLED\n');
  fs.writeFileSync(path.join(root, 'data', 'advert-body.txt'), 'RAW-ADVERT-BODY-MUST-NOT-BE-JOURNALLED\n');
  const config = loadWorkspaceConfig(root);
  config.profile.displayName = 'Synthetic Person';
  config.search.roleFamilies = ['Researcher'];
  config.search.locations = ['Remote'];
  writeWorkspaceConfig(root, config);
  const published = publishSearchProfile(draftProfileFromLegacy(config));
  const lanes = reconcileSearchLanePlan(loadSearchLanePlan(root), published);
  const migrated = migrateLegacyPortals(loadEmployerRegistry(root), [], {
    now: () => published.publishedAt,
  });
  const employers = reconcileEmployerDiscoveries(migrated, [], {
    now: () => published.publishedAt,
  });
  rerankHistoricalVacancies(root, published);
  const nextConfig = {
    ...config,
    searchProfile: { ...(config.searchProfile || {}), publishedId: published.id },
  };
  const runId = 'search-plan-publish-production-shaped';
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'search-plan-mutation',
    runId,
    phase: 'publish',
  });
  assert.ok(lease);
  try {
    publishProfileGeneration(
      { root, runId, lease },
      { profile: published, lanes, employers, config: nextConfig },
    );
  } finally {
    releaseScanLease(lease);
  }
  assert.equal(cleanJson(path.join(root, 'workspace.json')).searchProfile.publishedId, published.id);
  const recoveryRecord = fs.readFileSync(path.join(
    root,
    '.scout',
    'runs',
    runId,
    'mutations',
    fs.readdirSync(path.join(root, '.scout', 'runs', runId, 'mutations'))[0],
  ), 'utf8');
  assert.doesNotMatch(
    recoveryRecord,
    /PRIVATE-CV-BODY|RAW-PROVIDER-RESPONSE|RAW-ADVERT-BODY/,
  );
});
