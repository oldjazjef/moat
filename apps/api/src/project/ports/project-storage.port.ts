import type { StoragePort } from '@moat/core';

/**
 * Where the open project lives (DT-03). Today the project folder the desktop shell chose
 * (`MOAT_PROJECT_DIR`); null while none is open.
 */
export abstract class ProjectStoragePort {
  /** The folder shown to the user, or null when no project is open. */
  abstract location(): string | null;
  /** The project's files, or null when no project is open (or the folder is gone). */
  abstract open(): StoragePort | null;
}
