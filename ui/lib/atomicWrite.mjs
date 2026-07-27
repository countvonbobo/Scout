import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function atomicWriteFile(file, value, {
  encoding = typeof value === 'string' ? 'utf8' : undefined,
  fileSystem = fs,
  mode,
} = {}) {
  const directory = path.dirname(file);
  fileSystem.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
  const existingMode = fileSystem.existsSync(file) ? fileSystem.statSync(file).mode & 0o777 : undefined;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', mode ?? existingMode ?? 0o666);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fileSystem.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('Atomic file write made no progress');
      offset += written;
    }
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporary, file);
    const directoryDescriptor = fileSystem.openSync(directory, 'r');
    try {
      fileSystem.fsyncSync(directoryDescriptor);
    } catch (error) {
      // Windows does not expose POSIX directory fsync. The file itself was
      // flushed before replacement; surface every other platform failure.
      if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EISDIR'].includes(error?.code)) throw error;
    } finally {
      fileSystem.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
    try { fileSystem.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}
