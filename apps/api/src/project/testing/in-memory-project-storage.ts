import type { StoragePort } from '@moat/core';
import { ProjectStoragePort } from '../ports/project-storage.port';

/** A project folder in memory, for handler specs. */
export class InMemoryProjectStorage extends ProjectStoragePort {
  constructor(
    private readonly files: Record<string, string> | null,
    private readonly folder = '/projects/demo',
  ) {
    super();
  }

  location(): string | null {
    return this.files === null ? null : this.folder;
  }

  open(): StoragePort | null {
    const files = this.files;
    if (files === null) return null;
    return {
      read: (path) => files[path] ?? null,
      list: (dir) =>
        Object.keys(files)
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => path.slice(dir.length + 1))
          .filter((name) => !name.includes('/')),
    };
  }
}
