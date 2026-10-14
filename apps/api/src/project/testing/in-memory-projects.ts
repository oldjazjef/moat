import type { StoragePort } from '@moat/core';
import {
  BundleExistsError,
  FileExistsError,
  ProjectFilesPort,
} from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import type { ProjectEntry } from '../project.types';

/** The project list in memory, for handler specs. Ids are handed out as `id` + padding. */
export class InMemoryProjectRegistry extends ProjectRegistryPort {
  readonly entries: ProjectEntry[] = [];

  list(): readonly ProjectEntry[] {
    return [...this.entries];
  }

  get(id: string): ProjectEntry | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  add(folder: string): ProjectEntry {
    const known = this.entries.find((entry) => entry.folder === folder);
    if (known) return known;
    const entry = {
      id: `p${this.entries.length}`.padEnd(22, 'x'),
      folder,
    };
    this.entries.push(entry);
    return entry;
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }
}

/** Project folders in memory: folder → files; a folder not in the map is gone. */
export class InMemoryProjectFiles extends ProjectFilesPort {
  /** Folders whose moat.yaml cannot be written (read-only, not a regular file). */
  readonly readOnly = new Set<string>();

  constructor(readonly folders: Record<string, Record<string, string>>) {
    super();
  }

  writeConfig(folder: string, text: string): void {
    const files = this.folders[folder];
    if (files === undefined || this.readOnly.has(folder))
      throw new Error('not writable');
    files['moat.yaml'] = text;
  }

  writeBundle(
    folder: string,
    gate: string,
    version: number,
    text: string,
  ): void {
    const files = this.folders[folder];
    const path = `bundles/${gate}/${version}.json`;
    if (files === undefined || this.readOnly.has(folder))
      throw new Error('not writable');
    if (files[path] !== undefined) throw new BundleExistsError(path);
    files[path] = text;
  }

  writeSecret(folder: string, gate: string, name: string, text: string): void {
    const files = this.folders[folder];
    if (files === undefined || this.readOnly.has(folder))
      throw new Error('not writable');
    files[`secrets/${gate}/${name}.json`] = text;
  }

  createConfig(folder: string, text: string): void {
    this.create(folder, 'moat.yaml', text);
  }

  writeGate(folder: string, gate: string, text: string): void {
    this.create(folder, `gates/${gate}.json`, text);
  }

  private create(folder: string, path: string, text: string): void {
    const files = this.folders[folder];
    if (files === undefined || this.readOnly.has(folder))
      throw new Error('not writable');
    if (files[path] !== undefined) throw new FileExistsError(path);
    files[path] = text;
  }

  open(folder: string): StoragePort | null {
    const files = this.folders[folder];
    if (files === undefined) return null;
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
