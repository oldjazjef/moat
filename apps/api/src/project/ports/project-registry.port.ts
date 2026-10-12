import type { ProjectEntry } from '../project.types';

/** The list of projects (as lazy-koins: an abstract class as the port, adapters in persistence/). */
export abstract class ProjectRegistryPort {
  /** In the order they were added. */
  abstract list(): readonly ProjectEntry[];
  abstract get(id: string): ProjectEntry | null;
  /** Adds the folder, or returns its entry when it is in the list already. */
  abstract add(folder: string): ProjectEntry;
  /** Removes the entry (never the folder); false when there was none. */
  abstract remove(id: string): boolean;
}
