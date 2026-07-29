import fs from 'node:fs';
import path from 'node:path';

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function real(file) {
  return fs.realpathSync.native?.(file) ?? fs.realpathSync(file);
}

/**
 * Resolve a workspace-local path only after every existing lexical component
 * has been checked for symlink/reparse-point traversal and canonical escape.
 * Call this again inside the commit guard immediately before any replacement
 * or recursive removal; the first check is not a durable capability.
 */
export function validatePhysicalWorkspacePath(root, target, label = 'workspace path') {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  if (!inside(lexicalRoot, lexicalTarget)) throw new Error(`${label} escapes its workspace`);
  if (!fs.existsSync(lexicalRoot)) throw new Error(`${label} workspace root does not exist`);
  if (fs.lstatSync(lexicalRoot).isSymbolicLink()) {
    throw new Error(`${label} workspace root is a symlink or junction`);
  }
  const canonicalRoot = real(lexicalRoot);
  let lexical = lexicalRoot;
  for (const component of path.relative(lexicalRoot, lexicalTarget).split(path.sep).filter(Boolean)) {
    lexical = path.join(lexical, component);
    if (!fs.existsSync(lexical)) break;
    const stat = fs.lstatSync(lexical);
    if (stat.isSymbolicLink()) throw new Error(`${label} traverses a symlink or junction`);
    const canonical = real(lexical);
    if (!inside(canonicalRoot, canonical)) throw new Error(`${label} resolves outside its workspace`);
  }
  let existing = lexicalTarget;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`${label} has no existing workspace parent`);
    existing = parent;
  }
  if (!inside(canonicalRoot, real(existing))) throw new Error(`${label} parent resolves outside its workspace`);
  return lexicalTarget;
}
