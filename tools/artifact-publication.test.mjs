import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as release from './build-release.mjs';

function fixture(names = ['Scout.synthetic']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-publication-'));
  const outputDir = path.join(root, 'installer', 'output');
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  return {
    root,
    outputDir,
    names,
    remove() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function prepare(fix) {
  return release.createArtifactPublication({
    outputDir: fix.outputDir,
    authorityRoot: fix.root,
    artifactNames: fix.names,
  });
}

test('postcheck failure removes private temporary artifacts without exposing a final name', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const primary = new Error('post-package authorization failed');
    release.finishArtifactPublication(publication, { primaryError: primary });
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'Scout.synthetic')), false);
    assert.equal(fs.existsSync(publication.pendingDir), false);
    assert.equal(fs.existsSync(publication.lockDir), false);
    assert.equal(primary.message, 'post-package authorization failed');
  } finally {
    fix.remove();
  }
});

test('packager failure removes a partial private temporary artifact', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'partial bytes');
    release.finishArtifactPublication(publication, { primaryError: new Error('packager failed') });
    assert.equal(fs.existsSync(publication.pendingDir), false);
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'Scout.synthetic')), false);
  } finally {
    fix.remove();
  }
});

test('destination collision fails closed without overwriting the existing artifact', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'new bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    const finalPath = path.join(fix.outputDir, 'Scout.synthetic');
    fs.writeFileSync(finalPath, 'existing bytes');
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization),
      /destination already exists/,
    );
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'existing bytes');
    release.finishArtifactPublication(publication, { primaryError: new Error('collision') });
    assert.equal(fs.existsSync(publication.pendingDir), false);
  } finally {
    fix.remove();
  }
});

test('competing publication is excluded and the active publication may finish atomically', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    assert.throws(() => prepare(fix), /publication is already active/);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'winner');
    const authorization = release.authorizeArtifactPublication(publication);
    release.promoteArtifactPublication(publication, authorization);
    assert.equal(fs.readFileSync(path.join(fix.outputDir, 'Scout.synthetic'), 'utf8'), 'winner');
    const receipt = fs.readdirSync(fix.outputDir)
      .find((name) => name.startsWith('.scout-release-completed-'));
    assert.ok(receipt);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fix.outputDir, receipt), 'utf8')).state, 'complete');
  } finally {
    fix.remove();
  }
});

test('output-ancestor substitution invalidates publication authorization', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    const installer = path.join(fix.root, 'installer');
    const held = path.join(fix.root, 'installer-held');
    fs.renameSync(installer, held);
    fs.mkdirSync(fix.outputDir, { recursive: true });
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization),
      /publication authorization changed/,
    );
    fs.rmSync(installer, { recursive: true, force: true });
    fs.renameSync(held, installer);
    release.finishArtifactPublication(publication, { primaryError: new Error('substitution') });
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'Scout.synthetic')), false);
  } finally {
    fix.remove();
  }
});

test('temporary cleanup failure preserves the primary error and hides filesystem details', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'partial bytes');
    const primary = new Error('packager failed');
    assert.doesNotThrow(() => release.finishArtifactPublication(publication, {
      primaryError: primary,
      remove: () => { throw new Error('/private/path must not escape'); },
    }));
    assert.match(primary.message, /^packager failed\nRelease artifact temporary cleanup failed;/);
    assert.doesNotMatch(primary.message, /private\/path/);
    release.finishArtifactPublication(publication, { primaryError: primary });
  } finally {
    fix.remove();
  }
});

test('crash boundaries distinguish disposable pre-promotion residue from an authorized final inode', () => {
  const before = fixture();
  try {
    const publication = prepare(before);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'pre-promotion');
    assert.equal(fs.existsSync(publication.pendingDir), true);
    assert.equal(fs.existsSync(path.join(before.outputDir, 'Scout.synthetic')), false);
    release.finishArtifactPublication(publication);
    assert.equal(fs.existsSync(publication.pendingDir), false);
  } finally {
    before.remove();
  }

  const after = fixture();
  try {
    const publication = prepare(after);
    const temporary = publication.temporaryPaths['Scout.synthetic'];
    const finalPath = path.join(after.outputDir, 'Scout.synthetic');
    fs.writeFileSync(temporary, 'authorized final');
    const authorization = release.authorizeArtifactPublication(publication);
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        remove: () => { throw new Error('/private/path must not escape'); },
      }),
      /authorized final artifact exists.*temporary cleanup failed/i,
    );
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'authorized final');
    assert.notEqual(fs.statSync(finalPath).ino, fs.statSync(temporary).ino);
    release.finishArtifactPublication(publication);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.existsSync(publication.pendingDir), false);
  } finally {
    after.remove();
  }
});

test('publication rejects a symlinked or reparse-point output ancestor', () => {
  const fix = fixture();
  try {
    fs.rmSync(path.join(fix.root, 'installer'), { recursive: true, force: true });
    const redirected = path.join(fix.root, 'redirected');
    fs.mkdirSync(redirected);
    try {
      fs.symlinkSync(redirected, path.join(fix.root, 'installer'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && /EPERM|privilege/i.test(String(error))) return;
      throw error;
    }
    assert.throws(() => prepare(fix), /not a trusted directory/);
  } finally {
    fix.remove();
  }
});

test('authorization rejects a temporary directory whose privacy state changed', {
  skip: process.platform === 'win32' ? 'POSIX mode mutation; Windows DACLs are exercised by hosted packaging' : false,
}, () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    fs.chmodSync(publication.pendingDir, 0o755);
    assert.throws(
      () => release.authorizeArtifactPublication(publication),
      /publication authorization changed/,
    );
    fs.chmodSync(publication.pendingDir, 0o700);
    release.finishArtifactPublication(publication, { primaryError: new Error('privacy changed') });
  } finally {
    fix.remove();
  }
});

test('authorization rejects unexpected temporary output and publishes a temporary checksum manifest', () => {
  const fix = fixture(['Scout.synthetic', 'checksums.txt']);
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    release.writeArtifactChecksums(publication);
    fs.writeFileSync(path.join(publication.pendingDir, 'unexpected'), 'unexpected');
    assert.throws(() => release.authorizeArtifactPublication(publication), /not authorized/);
    fs.rmSync(path.join(publication.pendingDir, 'unexpected'));
    const authorization = release.authorizeArtifactPublication(publication);
    const result = release.promoteArtifactPublication(publication, authorization);
    const manifest = fs.readFileSync(result.finalPaths['checksums.txt'], 'utf8');
    assert.match(manifest, /^[a-f0-9]{64}  Scout\.synthetic\n$/);
  } finally {
    fix.remove();
  }
});

test('promotion rejects bytes changed through the newly linked sealed inode', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        afterLink: ({ temporary }) => {
          if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
          fs.writeFileSync(temporary, 'changed bytes!!!');
        },
      }),
      /authorization changed[\s\S]*final-name residue may exist/,
    );
    assert.equal(publication.recoveryRequired, true);
    assert.equal(fs.existsSync(path.join(publication.lockDir, 'transaction.json')), true);
  } finally {
    fix.remove();
  }
});

test('promotion rechecks the original output ancestor immediately after linking', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    const installer = path.join(fix.root, 'installer');
    const held = path.join(fix.root, 'installer-held-during-link');
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        afterLink: () => {
          fs.renameSync(installer, held);
          fs.mkdirSync(fix.outputDir, { recursive: true });
        },
      }),
      /authorization changed/,
    );
    assert.equal(publication.published, false);
  } finally {
    fix.remove();
  }
});

test('failed multi-output rollback retains durable recovery evidence and reports final-name residue', () => {
  const fix = fixture(['a.pkg', 'b.pkg']);
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['a.pkg'], 'artifact a');
    fs.writeFileSync(publication.temporaryPaths['b.pkg'], 'artifact b');
    const authorization = release.authorizeArtifactPublication(publication);
    let links = 0;
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        link: (source, target) => {
          links += 1;
          if (links === 2) {
            const error = new Error('injected collision');
            error.code = 'EEXIST';
            throw error;
          }
          fs.linkSync(source, target);
        },
        unlink: () => { throw new Error('injected rollback failure'); },
      }),
      /destination already exists[\s\S]*final-name residue may exist/,
    );
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'a.pkg')), false);
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'b.pkg')), false);
    const retainedRollback = fs.readdirSync(publication.lockDir)
      .find((name) => name.startsWith('.rollback-'));
    assert.ok(retainedRollback);
    assert.equal(
      fs.readFileSync(path.join(publication.lockDir, retainedRollback), 'utf8'),
      'artifact a',
    );
    assert.equal(fs.existsSync(path.join(publication.lockDir, 'transaction.json')), true);
    const primary = new Error('caller observed publication failure');
    release.finishArtifactPublication(publication, { primaryError: primary });
    assert.match(primary.message, /recovery evidence was retained for operator cleanup|temporary artifacts were retained/);
    assert.equal(fs.existsSync(publication.lockDir), true);
  } finally {
    fix.remove();
  }
});

test('completion-receipt validation failure rolls back the linked receipt and every artifact', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    let heldReceiptSource = null;
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        link: (source, target) => {
          fs.linkSync(source, target);
          if (path.basename(source) === 'transaction.complete.json') {
            heldReceiptSource = `${source}.held`;
            fs.renameSync(source, heldReceiptSource);
            fs.copyFileSync(heldReceiptSource, source);
          }
        },
      }),
      /completion receipt authorization changed/,
    );
    assert.ok(heldReceiptSource);
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'Scout.synthetic')), false);
    assert.deepEqual(
      fs.readdirSync(fix.outputDir).filter((name) => name.startsWith('.scout-release-completed-')),
      [],
    );
    assert.equal(publication.recoveryRequired, false);
    release.finishArtifactPublication(publication, { primaryError: new Error('receipt changed') });
    assert.equal(fs.existsSync(publication.lockDir), false);
  } finally {
    fix.remove();
  }
});

test('rollback quarantines a substituted final name without deleting the replacement', () => {
  const fix = fixture(['a.pkg', 'b.pkg']);
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['a.pkg'], 'artifact a');
    fs.writeFileSync(publication.temporaryPaths['b.pkg'], 'artifact b');
    const authorization = release.authorizeArtifactPublication(publication);
    const held = path.join(fix.outputDir, '.held-authorized-a');
    let links = 0;
    let substituted = false;
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        link: (source, target) => {
          links += 1;
          if (links === 2) {
            const error = new Error('injected collision');
            error.code = 'EEXIST';
            throw error;
          }
          fs.linkSync(source, target);
        },
        rollbackRename: (source, target) => {
          fs.renameSync(source, held);
          fs.writeFileSync(source, 'replacement must survive');
          fs.renameSync(source, target);
          substituted = true;
        },
      }),
      /destination already exists[\s\S]*recovery evidence was retained/,
    );
    assert.equal(substituted, true);
    assert.equal(fs.readFileSync(held, 'utf8'), 'artifact a');
    const retainedReplacement = fs.readdirSync(publication.lockDir)
      .find((name) => name.startsWith('.rollback-'));
    assert.ok(retainedReplacement);
    assert.equal(
      fs.readFileSync(path.join(publication.lockDir, retainedReplacement), 'utf8'),
      'replacement must survive',
    );
    assert.equal(publication.recoveryRequired, true);
  } finally {
    fix.remove();
  }
});

test('identity-bound cleanup never deletes a substituted pending directory', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'partial bytes');
    const held = `${publication.pendingDir}-held`;
    const primary = new Error('packager failed');
    release.finishArtifactPublication(publication, {
      primaryError: primary,
      removeOptions: {
        rename: (source, target) => {
          if (source === publication.pendingDir) {
            fs.renameSync(source, held);
            fs.mkdirSync(source);
            fs.writeFileSync(path.join(source, 'sentinel'), 'replacement must survive');
          }
          fs.renameSync(source, target);
        },
      },
    });
    assert.match(primary.message, /temporary cleanup failed/);
    const sentinels = fs.readdirSync(fix.outputDir)
      .filter((name) => name.startsWith('.scout-release-cleanup-pending-'))
      .map((name) => path.join(fix.outputDir, name, 'sentinel'));
    assert.equal(sentinels.length, 1);
    assert.equal(fs.readFileSync(sentinels[0], 'utf8'), 'replacement must survive');
    assert.equal(fs.existsSync(publication.lockDir), true);
    assert.equal(fs.existsSync(held), true);
  } finally {
    fix.remove();
  }
});

test('promotion authorizes its flushed transaction journal and rolls back if it disappears', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        afterLink: () => fs.unlinkSync(path.join(publication.lockDir, 'transaction.json')),
      }),
      /publication authorization changed/,
    );
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'Scout.synthetic')), false);
    release.finishArtifactPublication(publication, { primaryError: new Error('journal changed') });
    assert.equal(fs.existsSync(publication.pendingDir), false);
    assert.equal(fs.existsSync(publication.lockDir), false);
  } finally {
    fix.remove();
  }
});

test('rollback reports incomplete evidence when an authorized journal was removed', () => {
  const fix = fixture(['a.pkg', 'b.pkg']);
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['a.pkg'], 'artifact a');
    fs.writeFileSync(publication.temporaryPaths['b.pkg'], 'artifact b');
    const authorization = release.authorizeArtifactPublication(publication);
    let links = 0;
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        link: (source, target) => {
          links += 1;
          if (links === 2) throw new Error('injected second-link failure');
          fs.linkSync(source, target);
        },
        afterLink: () => fs.unlinkSync(path.join(publication.lockDir, 'transaction.json')),
        unlink: () => { throw new Error('injected rollback failure'); },
      }),
      /recovery evidence is incomplete/,
    );
    assert.equal(publication.recoveryRequired, true);
    assert.equal(fs.existsSync(path.join(publication.lockDir, 'transaction.json')), false);
    assert.equal(fs.existsSync(publication.lockDir), true);
  } finally {
    fix.remove();
  }
});

test('publisher-owned sealed directory identity is rechecked during copying', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        copy: (source, target, flags) => {
          const sealed = path.dirname(target);
          fs.renameSync(sealed, `${sealed}-held`);
          fs.mkdirSync(sealed, { mode: 0o755 });
          fs.copyFileSync(source, target, flags);
        },
      }),
      /publication authorization changed/,
    );
    assert.equal(fs.existsSync(path.join(fix.outputDir, 'Scout.synthetic')), false);
  } finally {
    fix.remove();
  }
});

test('cleanup rechecks quarantined identity before deleting any replacement content', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'partial bytes');
    const primary = new Error('packager failed');
    let replacement = null;
    release.finishArtifactPublication(publication, {
      primaryError: primary,
      removeOptions: {
        empty: (entry) => {
          const held = `${entry}-held`;
          fs.renameSync(entry, held);
          fs.mkdirSync(entry);
          fs.writeFileSync(path.join(entry, 'sentinel'), 'replacement must survive');
          replacement = entry;
        },
      },
    });
    assert.match(primary.message, /temporary cleanup failed/);
    assert.ok(replacement);
    assert.equal(fs.readFileSync(path.join(replacement, 'sentinel'), 'utf8'), 'replacement must survive');
    assert.equal(fs.existsSync(publication.lockDir), true);
  } finally {
    fix.remove();
  }
});

test('bound cleanup child rejects a substituted directory before deleting its contents', () => {
  const fix = fixture();
  const owned = path.join(fix.root, 'owned-cleanup');
  const held = `${owned}-held`;
  try {
    fs.mkdirSync(owned);
    fs.writeFileSync(path.join(owned, 'owned'), 'owned bytes');
    const stat = fs.lstatSync(owned, { bigint: true });
    const expectedRecord = { dev: String(stat.dev), ino: String(stat.ino) };
    fs.renameSync(owned, held);
    fs.mkdirSync(owned);
    fs.writeFileSync(path.join(owned, 'sentinel'), 'replacement must survive');
    assert.throws(
      () => release.emptyOwnedDirectory(owned, { expectedRecord }),
      /identity-bound directory emptying failed/,
    );
    assert.equal(fs.readFileSync(path.join(owned, 'sentinel'), 'utf8'), 'replacement must survive');
    assert.equal(fs.readFileSync(path.join(held, 'owned'), 'utf8'), 'owned bytes');
  } finally {
    fix.remove();
  }
});

test('promotion rechecks destination authority after successful temporary cleanup', () => {
  const fix = fixture();
  try {
    const publication = prepare(fix);
    fs.writeFileSync(publication.temporaryPaths['Scout.synthetic'], 'authorized bytes');
    const authorization = release.authorizeArtifactPublication(publication);
    const installer = path.join(fix.root, 'installer');
    const held = path.join(fix.root, 'installer-held-after-cleanup');
    assert.throws(
      () => release.promoteArtifactPublication(publication, authorization, {
        afterCleanup: () => {
          fs.renameSync(installer, held);
          fs.mkdirSync(fix.outputDir, { recursive: true });
        },
      }),
      /publication authorization changed/,
    );
    assert.equal(publication.published, true);
  } finally {
    fix.remove();
  }
});
