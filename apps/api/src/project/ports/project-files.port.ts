import type { StoragePort } from '@moat/core';

/** A project's files (DT-03): today always the project folder on disk. */
export abstract class ProjectFilesPort {
  /** The folder's files, or null when it can no longer be read. */
  abstract open(folder: string): StoragePort | null;

  /**
   * Replaces the project's moat.yaml with `text`, atomically. Throws when the folder or the file
   * cannot be written (gone, read-only, moat.yaml not a regular file).
   */
  abstract writeConfig(folder: string, text: string): void;
}
