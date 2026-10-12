import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
