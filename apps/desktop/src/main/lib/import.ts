import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ImportRefusal, ImportResult } from '../../shared/bridge';

/** What the main process hands the API (apps/api/src/project/application/bundle-import.service.ts). */
export type ImportInput =
  | { readonly kind: 'file'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'folder';
      readonly entries: readonly FolderEntry[];
      readonly read: (name: string) => ReadResult;
    };

/** The API's in-process answer. */
export type BundleImportResult =
  | { readonly status: 'imported'; readonly version: number }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'refused';
      readonly code: Exclude<ImportRefusal, 'key_missing'>;
    }
  | { readonly status: 'not_writable' };

/** What the page learns: the outcome, never a path. */
export function importOutcome(result: BundleImportResult): ImportResult {
  if (result.status === 'not_found') return { status: 'failed' };
  return result;
}

/**
 * Reading what the person chose to import (FR-45, DT-17, T-50), in the main process, before any of
 * it reaches the API: only regular files (never through a symbolic link), never more than a limit,
 * and a package folder only by its entries' names and kinds. What the bytes are is decided in core
 * (apps/api BundleImportService → planImport); nothing here parses them.
 */

/** A package ZIP is at most this big (core IMPORT_ZIP_LIMITS); a bundle file at most 1 MiB. */
export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_BUNDLE_BYTES = 1024 * 1024;
/** More entries than a package has: the folder is refused without listing further. */
export const MAX_FOLDER_ENTRIES = 8;

export type ReadResult = Uint8Array | 'too_large' | null;

/**
 * The bytes of a regular file, at most `maxBytes`; `too_large` above, null when it is not a
 * regular file (a link, a folder, a device …) or cannot be read.
 */
export function readImportFile(path: string, maxBytes: number): ReadResult {
  let fd: number;
  try {
    // A link is refused here, and O_NOFOLLOW (where there is one) closes the gap until open.
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return 'too_large';
    // Read one byte more than allowed: a file that grew meanwhile is still caught.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return 'too_large';
    }
    return new Uint8Array(buffer.subarray(0, length));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export interface FolderEntry {
  readonly name: string;
  /** `other`: a folder, a link or anything but a regular file. */
  readonly kind: 'file' | 'other';
}

/**
 * The entries of a package folder (one level, no link followed); null when it cannot be read.
 * Stops after MAX_FOLDER_ENTRIES + 1: core refuses that many anyway.
 */
export function listPackageFolder(dir: string): FolderEntry[] | null {
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    const handle = opendirSync(dir);
    const entries: FolderEntry[] = [];
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        entries.push({
          name: entry.name,
          kind: entry.isFile() ? 'file' : 'other',
        });
        if (entries.length > MAX_FOLDER_ENTRIES) break;
      }
    } finally {
      handle.closeSync();
    }
    return entries;
  } catch {
    return null;
  }
}

/** Reads `name` from the package folder; only a name core chose from listPackageFolder. */
export function readPackageFile(dir: string, name: string): ReadResult {
  if (
    name.includes('/') ||
    name.includes('\\') ||
    name === '..' ||
    name === '.'
  )
    return null;
  return readImportFile(join(dir, name), MAX_IMPORT_BUNDLE_BYTES);
}
