import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { StoragePort } from '@moat/core';

/** Larger than any moat.yaml (256 KiB), gate file, sealed secret or bundle (1 MiB). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** More entries than any project folder has: the rest is not listed. */
export const MAX_ENTRIES = 2000;

/** O_NOFOLLOW and O_NONBLOCK do not exist on Windows; there the checks on the open file remain. */
const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

/** A plain file name directly in the project folder; no dot files, no separators. */
const WRITABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A file the desktop may not replace: not a regular file, or the write failed. */
export class FolderWriteError extends Error {
  override readonly name = 'FolderWriteError';

  constructor(
    message: string,
    /** `exists`: create() found a file at the path already (nothing was written). */
    readonly reason: 'exists' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

/**
 * The project folder on disk (DT-03, DT-14) behind the core's StoragePort. Every path stays
 * inside the folder — also through symbolic links, which are followed only when their target
 * lies inside it — and only regular files up to MAX_FILE_BYTES are read. Anything else counts
 * as absent, so a broken or hostile folder shows up as "missing" or "invalid" in the UI and
 * never as a read of some other file.
 */
export class FolderStorage implements StoragePort {
  private readonly root: string;

  constructor(folder: string) {
    this.root = realpathSync(folder);
  }

  read(path: string): string | null {
    const file = this.inside(path);
    if (file === null) return null;
    let fd: number;
    try {
      // No following a link swapped in after the check, no blocking on a FIFO: the checks below
      // run on the opened file itself, so nothing can change between check and read.
      fd = openSync(file, OPEN_FLAGS);
    } catch {
      return null;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      // One byte more than the file has: filling it means the file grew while being read.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length === buffer.length) return null;
      return buffer.toString('utf8', 0, length);
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  list(dir: string): readonly string[] {
    const folder = this.inside(dir);
    if (folder === null) return [];
    try {
      if (!lstatSync(folder).isDirectory()) return [];
      return readdirSync(folder).slice(0, MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  /**
   * Replaces the file at `path` (`moat.yaml`, `secrets/site/hubspot-token.json`), atomically: the
   * text goes into a new temporary file in the same folder, is flushed, and is renamed over the old
   * one, so a reader sees the old or the new file and never half of one (CLAUDE.md, PHP standards:
   * Files, applied here too). Folders on the way are created when missing and must be real
   * folders; every part of the path is a plain name. Anything at `path` that is not a regular file
   * is refused: a symbolic link is never written through. The old file's permissions are kept.
   */
  replace(path: string, text: string): void {
    const { dir, name } = this.folderFor(path);
    const target = join(dir, name);
    let mode = 0o644;
    try {
      const stat = lstatSync(target);
      if (!stat.isFile()) throw new FolderWriteError('not a regular file');
      mode = stat.mode & 0o777;
    } catch (error) {
      if (error instanceof FolderWriteError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new FolderWriteError('cannot check the file');
    }
    const temp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      // 'wx': a file that appeared under the random name is never overwritten or followed.
      writeNew(temp, text, mode);
      renameSync(temp, target);
    } catch {
      rmSync(temp, { force: true });
      throw new FolderWriteError('write failed');
    }
  }

  /**
   * Creates a new file at `path` (e.g. `bundles/site/3.json`), never replacing one: folders as in
   * replace(), and the text is written to a temporary file and then hard-linked to its name, which
   * fails when a file is there already. A reader never sees half a file.
   */
  create(path: string, text: string): void {
    const { dir, name } = this.folderFor(path);
    const target = join(dir, name);
    const temp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      writeNew(temp, text, 0o644);
      linkSync(temp, target);
    } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? new FolderWriteError('exists', 'exists')
        : new FolderWriteError('write failed');
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /** The folder of `path` (created when missing, never a symbolic link) and the file's name. */
  private folderFor(path: string): { dir: string; name: string } {
    const parts = path.split('/');
    if (!parts.every((part) => WRITABLE_NAME.test(part)))
      throw new FolderWriteError('invalid path');
    const name = parts.pop() as string;
    let dir = this.root;
    for (const part of parts) {
      dir = join(dir, part);
      try {
        mkdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new FolderWriteError('cannot create the folder');
      }
      try {
        if (!lstatSync(dir).isDirectory())
          throw new FolderWriteError('not a folder');
      } catch (error) {
        if (error instanceof FolderWriteError) throw error;
        throw new FolderWriteError('cannot check the folder');
      }
    }
    return { dir, name };
  }

  /** The real path of `path` below the root, or null when it is absent or leads outside. */
  private inside(path: string): string | null {
    if (isAbsolute(path) || path.includes('\0')) return null;
    let real: string;
    try {
      real = realpathSync(resolve(this.root, path));
    } catch {
      return null;
    }
    const rest = relative(this.root, real);
    return rest !== '' &&
      !rest.startsWith(`..${sep}`) &&
      rest !== '..' &&
      !isAbsolute(rest)
      ? real
      : null;
  }
}

/** Writes a file that must not exist yet ('wx': never overwritten, never followed), flushed. */
function writeNew(path: string, text: string, mode: number): void {
  const fd = openSync(path, 'wx', mode);
  try {
    const bytes = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < bytes.length)
      written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
