import type { StoragePort } from '@moat/core';

/** writeBundle found that version of the gate's bundle there already; nothing was written. */
export class BundleExistsError extends Error {
  override readonly name = 'BundleExistsError';
}

/** A project's files (DT-03): today always the project folder on disk. */
export abstract class ProjectFilesPort {
  /** The folder's files, or null when it can no longer be read. */
  abstract open(folder: string): StoragePort | null;

  /**
   * Replaces the project's moat.yaml with `text`, atomically. Throws when the folder or the file
   * cannot be written (gone, read-only, moat.yaml not a regular file).
   */
  abstract writeConfig(folder: string, text: string): void;

  /**
   * Writes a new signed bundle to `bundles/<gate>/<version>.json`. Never replaces a file: throws
   * BundleExistsError when that version is there already, another error when the folder cannot
   * be written.
   */
  abstract writeBundle(
    folder: string,
    gate: string,
    version: number,
    text: string,
  ): void;
}
