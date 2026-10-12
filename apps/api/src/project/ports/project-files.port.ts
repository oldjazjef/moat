import type { StoragePort } from '@moat/core';

/** A project's files (DT-03): today always the project folder on disk. */
export abstract class ProjectFilesPort {
  /** The folder's files, or null when it can no longer be read. */
  abstract open(folder: string): StoragePort | null;
}
