import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';

export const RECOVERY_FORMAT = 1;
export const RECOVERY_DIR = '.scout-backup/v1';
const HEADER = 'header.json';
const BLOB_DIR = 'files';
const INDEX_AAD = Buffer.from('scout-recovery-index-v1');
const PASSPHRASE_PREFIX = 'passphrase';
const RECOVERY_PREFIX = 'SCOUT-1-';
const MAX_HEADER_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERY_FILE_BYTES = 100 * 1024 * 1024;
const MAX_RECOVERY_FILES = 5000;
const ASYNC_IO_CHUNK_BYTES = 1024 * 1024;

function b64(buffer) { return Buffer.from(buffer).toString('base64url'); }
function unb64(value) { return Buffer.from(String(value || ''), 'base64url'); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function atomicWrite(file, value) {
  atomicWriteFile(file, value, { mode: 0o600 });
}

function eventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function checkFence(assertFence) {
  if (typeof assertFence === 'function') assertFence();
}

async function fencedMutation(assertFence, mutation) {
  checkFence(assertFence);
  const result = await mutation();
  checkFence(assertFence);
  return result;
}

async function atomicWriteAsync(file, value, { assertFence } = {}) {
  const directory = path.dirname(file);
  await fencedMutation(assertFence, () => fs.promises.mkdir(directory, { recursive: true }));
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  let descriptor;
  try {
    checkFence(assertFence);
    descriptor = await fs.promises.open(temporary, 'wx', 0o600);
    checkFence(assertFence);
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(ASYNC_IO_CHUNK_BYTES, bytes.length - offset);
      checkFence(assertFence);
      const { bytesWritten } = await descriptor.write(bytes, offset, length, offset);
      checkFence(assertFence);
      if (!bytesWritten) throw new Error('Atomic file write made no progress');
      offset += bytesWritten;
      await eventLoopTurn();
    }
    checkFence(assertFence);
    await descriptor.sync();
    checkFence(assertFence);
    await descriptor.close();
    descriptor = undefined;
    await fencedMutation(assertFence, () => fs.promises.rename(temporary, file));
    let directoryDescriptor;
    try {
      directoryDescriptor = await fs.promises.open(directory, 'r');
      checkFence(assertFence);
      await directoryDescriptor.sync();
      checkFence(assertFence);
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EISDIR'].includes(error?.code)) throw error;
    } finally {
      await directoryDescriptor?.close();
    }
  } catch (error) {
    try { await descriptor?.close(); } catch {}
    try {
      checkFence(assertFence);
      await fs.promises.rm(temporary, { force: true });
      checkFence(assertFence);
    } catch {}
    throw error;
  }
}

function aesEncrypt(key, plaintext, aad = Buffer.alloc(0)) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad.length) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(ciphertext) };
}

async function aesEncryptAsync(key, plaintext, aad = Buffer.alloc(0)) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad.length) cipher.setAAD(aad);
  const ciphertext = [];
  for (let offset = 0; offset < plaintext.length; offset += ASYNC_IO_CHUNK_BYTES) {
    ciphertext.push(cipher.update(plaintext.subarray(offset, offset + ASYNC_IO_CHUNK_BYTES)));
    await eventLoopTurn();
  }
  ciphertext.push(cipher.final());
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(Buffer.concat(ciphertext)) };
}

function aesDecrypt(key, record, aad = Buffer.alloc(0)) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(record.iv));
  if (aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(unb64(record.tag));
  return Buffer.concat([decipher.update(unb64(record.data)), decipher.final()]);
}

async function aesDecryptAsync(key, record, aad = Buffer.alloc(0)) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(record.iv));
  if (aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(unb64(record.tag));
  const encrypted = unb64(record.data);
  const plaintext = [];
  for (let offset = 0; offset < encrypted.length; offset += ASYNC_IO_CHUNK_BYTES) {
    plaintext.push(decipher.update(encrypted.subarray(offset, offset + ASYNC_IO_CHUNK_BYTES)));
    await eventLoopTurn();
  }
  plaintext.push(decipher.final());
  return Buffer.concat(plaintext);
}

async function sha256Async(buffer) {
  const hash = crypto.createHash('sha256');
  for (let offset = 0; offset < buffer.length; offset += ASYNC_IO_CHUNK_BYTES) {
    hash.update(buffer.subarray(offset, offset + ASYNC_IO_CHUNK_BYTES));
    await eventLoopTurn();
  }
  return hash.digest('hex');
}

function passphraseKey(passphrase, salt) {
  if (String(passphrase || '').length < 12) throw new Error('Recovery passphrase must be at least 12 characters');
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1 });
}

function recoveryKeyBytes(value) {
  const normalized = String(value || '').trim();
  if (!normalized.startsWith(RECOVERY_PREFIX)) throw new Error('Invalid Scout recovery key');
  const bytes = unb64(normalized.slice(RECOVERY_PREFIX.length));
  if (bytes.length !== 32) throw new Error('Invalid Scout recovery key');
  return bytes;
}

export function createRecoveryKeys(passphrase) {
  const dataKey = crypto.randomBytes(32);
  const recoveryBytes = crypto.randomBytes(32);
  const recoveryKey = `${RECOVERY_PREFIX}${b64(recoveryBytes)}`;
  const salt = crypto.randomBytes(16);
  const passKey = passphraseKey(passphrase, salt);
  return {
    dataKey,
    recoveryKey,
    header: {
      formatVersion: RECOVERY_FORMAT,
      cipher: 'aes-256-gcm',
      kdf: { name: 'scrypt', salt: b64(salt), N: 16384, r: 8, p: 1 },
      wrappedKeys: {
        passphrase: aesEncrypt(passKey, dataKey, Buffer.from(PASSPHRASE_PREFIX)),
        recovery: aesEncrypt(recoveryBytes, dataKey, Buffer.from('recovery')),
      },
      index: null,
      updatedAt: null,
    },
  };
}

export function unlockRecoveryKey(header, secret) {
  if (header?.formatVersion !== RECOVERY_FORMAT || header?.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported Scout recovery format');
  }
  const value = String(secret || '').trim();
  try {
    if (value.startsWith(RECOVERY_PREFIX)) {
      return aesDecrypt(recoveryKeyBytes(value), header.wrappedKeys.recovery, Buffer.from('recovery'));
    }
    const kdf = header.kdf || {};
    if (kdf.name !== 'scrypt') throw new Error('Unsupported recovery key derivation');
    return aesDecrypt(passphraseKey(value, unb64(kdf.salt)), header.wrappedKeys.passphrase, Buffer.from(PASSPHRASE_PREFIX));
  } catch {
    throw new Error('The recovery passphrase or key is incorrect');
  }
}

function walk(root, relative, out) {
  const absolute = path.join(root, ...relative.split('/'));
  if (!fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Recovery backup does not accept symbolic links: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute)) walk(root, `${relative}/${name}`, out);
  } else if (stat.isFile()) out.push(relative);
}

async function walkAsync(root, relative, out) {
  const absolute = path.join(root, ...relative.split('/'));
  try {
    await fs.promises.access(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const stat = await fs.promises.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Recovery backup does not accept symbolic links: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of await fs.promises.readdir(absolute)) {
      await walkAsync(root, `${relative}/${name}`, out);
      await eventLoopTurn();
    }
  } else if (stat.isFile()) out.push(relative);
}

export function recoveryFileList(workspaceRoot) {
  const files = [];
  for (const relative of ['.env', '.scout/backups', '.scout/onboarding', 'data/chats']) walk(workspaceRoot, relative, files);
  const applications = path.join(workspaceRoot, 'applications');
  if (fs.existsSync(applications)) {
    const candidates = [];
    walk(workspaceRoot, 'applications', candidates);
    files.push(...candidates.filter((file) => /\.(?:pdf|docx)$/i.test(file)));
  }
  return [...new Set(files)].sort();
}

async function recoveryFileListAsync(workspaceRoot) {
  const files = [];
  for (const relative of ['.env', '.scout/backups', '.scout/onboarding', 'data/chats']) {
    await walkAsync(workspaceRoot, relative, files);
  }
  const applications = path.join(workspaceRoot, 'applications');
  try {
    await fs.promises.access(applications);
  } catch (error) {
    if (error?.code === 'ENOENT') return [...new Set(files)].sort();
    throw error;
  }
  const candidates = [];
  await walkAsync(workspaceRoot, 'applications', candidates);
  files.push(...candidates.filter((file) => /\.(?:pdf|docx)$/i.test(file)));
  return [...new Set(files)].sort();
}

function safeRecoveryPath(relative) {
  const value = String(relative || '').replaceAll('\\', '/');
  if (!value || value.startsWith('/') || value.includes('\0')) throw new Error('Invalid recovery path');
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) throw new Error('Invalid recovery path');
  const allowed = normalized === '.env'
    || normalized.startsWith('applications/')
    || normalized.startsWith('.scout/backups/')
    || normalized.startsWith('.scout/onboarding/')
    || normalized.startsWith('data/chats/')
    || normalized === '__device__/preferences.json';
  if (!allowed) throw new Error(`Recovery path is not allowed: ${normalized}`);
  return normalized;
}

function opaqueId(dataKey, relative) {
  return crypto.createHmac('sha256', dataKey).update(relative).digest('hex');
}

function readHeader(workspaceRoot) {
  const file = path.join(workspaceRoot, RECOVERY_DIR, HEADER);
  if (!fs.existsSync(file)) throw new Error('This workspace does not contain encrypted recovery data');
  if (fs.statSync(file).size > MAX_HEADER_BYTES) throw new Error('Scout recovery header is too large');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function readHeaderAsync(workspaceRoot) {
  const file = path.join(workspaceRoot, RECOVERY_DIR, HEADER);
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('This workspace does not contain encrypted recovery data');
    throw error;
  }
  if (stat.size > MAX_HEADER_BYTES) throw new Error('Scout recovery header is too large');
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

function readIndex(header, dataKey) {
  if (!header.index) return { files: [] };
  const value = aesDecrypt(dataKey, header.index, INDEX_AAD);
  const parsed = JSON.parse(value.toString('utf8'));
  if (!Array.isArray(parsed.files)) throw new Error('Recovery index is invalid');
  if (parsed.files.length > MAX_RECOVERY_FILES) throw new Error('Recovery index contains too many files');
  return parsed;
}

export function writeRecoveryBackup(workspaceRoot, dataKey, header, { devicePreferences } = {}) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('Invalid recovery data key');
  const root = path.join(workspaceRoot, RECOVERY_DIR);
  const blobRoot = path.join(root, BLOB_DIR);
  fs.mkdirSync(blobRoot, { recursive: true });
  let previous = { files: [] };
  try { previous = readIndex(header, dataKey); } catch { /* a new header has no index */ }
  const previousByPath = new Map(previous.files.map((entry) => [entry.path, entry]));
  const sources = recoveryFileList(workspaceRoot).map((relative) => {
    let data = fs.readFileSync(path.join(workspaceRoot, ...relative.split('/')));
    if (relative.startsWith('data/chats/') && relative.endsWith('.json')) {
      const chat = JSON.parse(data.toString('utf8'));
      chat.cliSessionId = null;
      data = Buffer.from(`${JSON.stringify(chat, null, 2)}\n`);
    }
    return { path: safeRecoveryPath(relative), data };
  });
  if (devicePreferences !== undefined && devicePreferences !== null) sources.push({
    path: '__device__/preferences.json',
    data: Buffer.from(`${JSON.stringify({ startWithWindows: Boolean(devicePreferences.startWithWindows) }, null, 2)}\n`),
  });
  if (sources.length > MAX_RECOVERY_FILES) throw new Error('Recovery backup contains too many files');

  const entries = [];
  for (const source of sources) {
    if (source.data.length > MAX_RECOVERY_FILE_BYTES) throw new Error(`Recovery file is too large: ${source.path}`);
    const hash = sha256(source.data);
    const id = opaqueId(dataKey, source.path);
    const blob = path.join(blobRoot, `${id}.json`);
    const old = previousByPath.get(source.path);
    if (!old || old.sha256 !== hash || old.id !== id || !fs.existsSync(blob)) {
      atomicWrite(blob, `${JSON.stringify(aesEncrypt(dataKey, source.data, Buffer.from(`file:${source.path}`)))}\n`);
    }
    entries.push({ path: source.path, id, sha256: hash, size: source.data.length });
  }
  if (devicePreferences === undefined) {
    const previousDevice = previousByPath.get('__device__/preferences.json');
    if (previousDevice) {
      const blob = path.join(blobRoot, `${previousDevice.id}.json`);
      if (!fs.existsSync(blob)) throw new Error('Recovery data is incomplete: device preferences');
      entries.push(previousDevice);
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const keep = new Set(entries.map((entry) => `${entry.id}.json`));
  for (const name of fs.readdirSync(blobRoot)) if (!keep.has(name)) fs.rmSync(path.join(blobRoot, name), { force: true });

  if (header.index && JSON.stringify(entries) === JSON.stringify(previous.files)) {
    return { header, files: entries.length, changed: false };
  }

  const next = {
    ...header,
    index: aesEncrypt(dataKey, Buffer.from(JSON.stringify({ files: entries })), INDEX_AAD),
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(path.join(root, HEADER), `${JSON.stringify(next, null, 2)}\n`);
  return { header: next, files: entries.length, changed: true };
}

export async function writeRecoveryBackupAsync(workspaceRoot, dataKey, header, {
  devicePreferences,
  assertFence,
} = {}) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('Invalid recovery data key');
  const root = path.join(workspaceRoot, RECOVERY_DIR);
  const blobRoot = path.join(root, BLOB_DIR);
  await fencedMutation(assertFence, () => fs.promises.mkdir(blobRoot, { recursive: true }));
  let previous = { files: [] };
  try { previous = readIndex(header, dataKey); } catch { /* a new header has no index */ }
  const previousByPath = new Map(previous.files.map((entry) => [entry.path, entry]));
  const sourcePaths = await recoveryFileListAsync(workspaceRoot);
  if (devicePreferences !== undefined && devicePreferences !== null) {
    sourcePaths.push('__device__/preferences.json');
  }
  if (sourcePaths.length > MAX_RECOVERY_FILES) throw new Error('Recovery backup contains too many files');

  const entries = [];
  for (const sourcePath of sourcePaths) {
    const relative = safeRecoveryPath(sourcePath);
    let data;
    if (relative === '__device__/preferences.json') {
      data = Buffer.from(`${JSON.stringify({ startWithWindows: Boolean(devicePreferences.startWithWindows) }, null, 2)}\n`);
    } else {
      data = await fs.promises.readFile(path.join(workspaceRoot, ...relative.split('/')));
      if (relative.startsWith('data/chats/') && relative.endsWith('.json')) {
        const chat = JSON.parse(data.toString('utf8'));
        chat.cliSessionId = null;
        data = Buffer.from(`${JSON.stringify(chat, null, 2)}\n`);
      }
    }
    if (data.length > MAX_RECOVERY_FILE_BYTES) throw new Error(`Recovery file is too large: ${relative}`);
    const hash = await sha256Async(data);
    const id = opaqueId(dataKey, relative);
    const blob = path.join(blobRoot, `${id}.json`);
    const old = previousByPath.get(relative);
    let blobExists = false;
    try {
      await fs.promises.access(blob);
      blobExists = true;
    } catch {}
    if (!old || old.sha256 !== hash || old.id !== id || !blobExists) {
      const encrypted = await aesEncryptAsync(dataKey, data, Buffer.from(`file:${relative}`));
      await atomicWriteAsync(blob, `${JSON.stringify(encrypted)}\n`, { assertFence });
    }
    entries.push({ path: relative, id, sha256: hash, size: data.length });
    await eventLoopTurn();
  }
  if (devicePreferences === undefined) {
    const previousDevice = previousByPath.get('__device__/preferences.json');
    if (previousDevice) {
      const blob = path.join(blobRoot, `${previousDevice.id}.json`);
      try { await fs.promises.access(blob); } catch { throw new Error('Recovery data is incomplete: device preferences'); }
      entries.push(previousDevice);
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const keep = new Set(entries.map((entry) => `${entry.id}.json`));
  for (const name of await fs.promises.readdir(blobRoot)) {
    if (!keep.has(name)) {
      await fencedMutation(assertFence, () => fs.promises.rm(path.join(blobRoot, name), { force: true }));
    }
    await eventLoopTurn();
  }

  if (header.index && JSON.stringify(entries) === JSON.stringify(previous.files)) {
    return { header, files: entries.length, changed: false };
  }

  const next = {
    ...header,
    index: await aesEncryptAsync(dataKey, Buffer.from(JSON.stringify({ files: entries })), INDEX_AAD),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteAsync(path.join(root, HEADER), `${JSON.stringify(next, null, 2)}\n`, { assertFence });
  return { header: next, files: entries.length, changed: true };
}

export function initializeRecoveryBackup(workspaceRoot, passphrase, options = {}) {
  const created = createRecoveryKeys(passphrase);
  const written = writeRecoveryBackup(workspaceRoot, created.dataKey, created.header, options);
  return { ...written, dataKey: created.dataKey, recoveryKey: created.recoveryKey };
}

export function rotateRecoveryPassphrase(workspaceRoot, dataKey, passphrase) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('Invalid recovery data key');
  const header = readHeader(workspaceRoot);
  if (header?.formatVersion !== RECOVERY_FORMAT || header?.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported Scout recovery format');
  }
  const salt = crypto.randomBytes(16);
  const passKey = passphraseKey(passphrase, salt);
  const next = {
    ...header,
    kdf: { name: 'scrypt', salt: b64(salt), N: 16384, r: 8, p: 1 },
    wrappedKeys: {
      ...header.wrappedKeys,
      passphrase: aesEncrypt(passKey, dataKey, Buffer.from(PASSPHRASE_PREFIX)),
    },
  };
  atomicWrite(path.join(workspaceRoot, RECOVERY_DIR, HEADER), `${JSON.stringify(next, null, 2)}\n`);
  return { header: next };
}

export function restoreRecoveryBackup(workspaceRoot, destinationRoot, secret) {
  const header = readHeader(workspaceRoot);
  const dataKey = unlockRecoveryKey(header, secret);
  return restoreRecoveryBackupWithKey(workspaceRoot, destinationRoot, dataKey, header);
}

function ensureSafeAncestors(root, target) {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Recovery destination contains a symbolic link');
  }
}

async function ensureSafeAncestorsAsync(root, target) {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) {
        throw new Error('Recovery destination contains a symbolic link');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function restoreRecoveryBackupWithKey(workspaceRoot, destinationRoot, dataKey, suppliedHeader = null) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('Invalid recovery data key');
  const header = suppliedHeader || readHeader(workspaceRoot);
  if (header?.formatVersion !== RECOVERY_FORMAT || header?.cipher !== 'aes-256-gcm') throw new Error('Unsupported Scout recovery format');
  const index = readIndex(header, dataKey);
  let devicePreferences = null;
  for (const entry of index.files) {
    const relative = safeRecoveryPath(entry.path);
    if (opaqueId(dataKey, relative) !== entry.id) throw new Error('Recovery index was modified');
    const blobFile = path.join(workspaceRoot, RECOVERY_DIR, BLOB_DIR, `${entry.id}.json`);
    if (!fs.existsSync(blobFile)) throw new Error(`Recovery data is incomplete: ${relative}`);
    if (fs.statSync(blobFile).size > MAX_RECOVERY_FILE_BYTES * 2) throw new Error(`Recovery blob is too large: ${relative}`);
    const record = JSON.parse(fs.readFileSync(blobFile, 'utf8'));
    const value = aesDecrypt(dataKey, record, Buffer.from(`file:${relative}`));
    if (sha256(value) !== entry.sha256 || value.length !== entry.size) throw new Error(`Recovery data was modified: ${relative}`);
    if (relative === '__device__/preferences.json') {
      devicePreferences = JSON.parse(value.toString('utf8'));
      continue;
    }
    const target = path.resolve(destinationRoot, ...relative.split('/'));
    const root = `${path.resolve(destinationRoot)}${path.sep}`;
    if (!target.startsWith(root)) throw new Error('Recovery path escaped the workspace');
    ensureSafeAncestors(path.resolve(destinationRoot), target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let restoredValue = value;
    if (relative.startsWith('data/chats/') && relative.endsWith('.json')) {
      const chat = JSON.parse(value.toString('utf8'));
      chat.cliSessionId = null;
      chat.recovered = { at: new Date().toISOString(), providerSessionReset: true };
      chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
      if (!chat.messages.some((message) => message.role === 'system' && message.recoveryNotice === true)) {
        chat.messages.push({
          role: 'system',
          text: 'This transcript was recovered on a new Scout host. Your next message starts a new provider session.',
          recoveryNotice: true,
          ts: chat.recovered.at,
        });
      }
      restoredValue = Buffer.from(`${JSON.stringify(chat, null, 2)}\n`);
    }
    atomicWrite(target, restoredValue);
  }
  return { dataKey, files: index.files.length, devicePreferences };
}

export async function restoreRecoveryBackupWithKeyAsync(
  workspaceRoot,
  destinationRoot,
  dataKey,
  suppliedHeader = null,
  { assertFence } = {},
) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('Invalid recovery data key');
  const header = suppliedHeader || await readHeaderAsync(workspaceRoot);
  if (header?.formatVersion !== RECOVERY_FORMAT || header?.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported Scout recovery format');
  }
  const index = readIndex(header, dataKey);
  let devicePreferences = null;
  for (const entry of index.files) {
    const relative = safeRecoveryPath(entry.path);
    if (opaqueId(dataKey, relative) !== entry.id) throw new Error('Recovery index was modified');
    const blobFile = path.join(workspaceRoot, RECOVERY_DIR, BLOB_DIR, `${entry.id}.json`);
    let blobStat;
    try {
      blobStat = await fs.promises.stat(blobFile);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Recovery data is incomplete: ${relative}`);
      throw error;
    }
    if (blobStat.size > MAX_RECOVERY_FILE_BYTES * 2) throw new Error(`Recovery blob is too large: ${relative}`);
    const record = JSON.parse(await fs.promises.readFile(blobFile, 'utf8'));
    const value = await aesDecryptAsync(dataKey, record, Buffer.from(`file:${relative}`));
    if (await sha256Async(value) !== entry.sha256 || value.length !== entry.size) {
      throw new Error(`Recovery data was modified: ${relative}`);
    }
    if (relative === '__device__/preferences.json') {
      devicePreferences = JSON.parse(value.toString('utf8'));
      continue;
    }
    const target = path.resolve(destinationRoot, ...relative.split('/'));
    const root = `${path.resolve(destinationRoot)}${path.sep}`;
    if (!target.startsWith(root)) throw new Error('Recovery path escaped the workspace');
    await ensureSafeAncestorsAsync(path.resolve(destinationRoot), target);
    let restoredValue = value;
    if (relative.startsWith('data/chats/') && relative.endsWith('.json')) {
      const chat = JSON.parse(value.toString('utf8'));
      chat.cliSessionId = null;
      chat.recovered = { at: new Date().toISOString(), providerSessionReset: true };
      chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
      if (!chat.messages.some((message) => message.role === 'system' && message.recoveryNotice === true)) {
        chat.messages.push({
          role: 'system',
          text: 'This transcript was recovered on a new Scout host. Your next message starts a new provider session.',
          recoveryNotice: true,
          ts: chat.recovered.at,
        });
      }
      restoredValue = Buffer.from(`${JSON.stringify(chat, null, 2)}\n`);
    }
    await atomicWriteAsync(target, restoredValue, { assertFence });
    await eventLoopTurn();
  }
  return { dataKey, files: index.files.length, devicePreferences };
}

export function loadRecoveryHeader(workspaceRoot) { return readHeader(workspaceRoot); }
