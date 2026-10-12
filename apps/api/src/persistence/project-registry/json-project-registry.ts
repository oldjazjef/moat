import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { ProjectRegistryPort } from '../../project/ports/project-registry.port';
import { PROJECT_ID, type ProjectEntry } from '../../project/project.types';

/** `<MOAT_DATA_DIR>/projects.json`. */
export const REGISTRY_FILE = 'projects.json';
/** More projects than anyone keeps in one list; a longer file is read up to here. */
export const MAX_PROJECTS = 200;
/** Far above MAX_PROJECTS entries with long paths. */
const MAX_FILE_BYTES = 256 * 1024;

interface RegistryFile {
  readonly version: 1;
  readonly projects: readonly ProjectEntry[];
}

/**
 * The project list as one small JSON file in the API's data folder, read on every call (it is
 * tiny, and another window of a future version may have changed it) and written atomically
 * (temp file + rename, 0600). An unreadable or damaged file reads as an empty list (and is kept
 * aside as `projects.json.damaged-<time>` on the next write); entries that are not well-formed
 * are skipped, never trusted.
 */
@Injectable()
export class JsonProjectRegistry extends ProjectRegistryPort {
  private readonly file: string;
  /** The last read found a file that is not a project list. */
  private damaged = false;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.file = join(
      config.get('MOAT_DATA_DIR', { infer: true }),
      REGISTRY_FILE,
    );
  }

  list(): readonly ProjectEntry[] {
    return this.read();
  }

  get(id: string): ProjectEntry | null {
    return this.read().find((entry) => entry.id === id) ?? null;
  }

  add(folder: string): ProjectEntry {
    const entries = this.read();
    const known = entries.find((entry) => entry.folder === folder);
    if (known) return known;
    if (entries.length >= MAX_PROJECTS) {
      throw new Error('The project list is full');
    }
    const entry = { id: randomBytes(16).toString('base64url'), folder };
    this.write([...entries, entry]);
    return entry;
  }

  remove(id: string): boolean {
    const entries = this.read();
    const rest = entries.filter((entry) => entry.id !== id);
    if (rest.length === entries.length) return false;
    this.write(rest);
    return true;
  }

  private read(): ProjectEntry[] {
    let value: unknown;
    try {
      if (statSync(this.file).size > MAX_FILE_BYTES) {
        this.damaged = true;
        return [];
      }
      value = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      // Missing = a first start; anything else is a damaged file.
      this.damaged = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      return [];
    }
    const projects =
      typeof value === 'object' && value !== null
        ? (value as { projects?: unknown }).projects
        : undefined;
    if (!Array.isArray(projects)) {
      this.damaged = true;
      return [];
    }
    this.damaged = false;
    const entries: ProjectEntry[] = [];
    for (const item of projects.slice(0, MAX_PROJECTS) as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, folder } = item as Record<string, unknown>;
      if (
        typeof id === 'string' &&
        PROJECT_ID.test(id) &&
        typeof folder === 'string' &&
        isAbsolute(folder) &&
        !folder.includes('\0') &&
        !entries.some((entry) => entry.id === id)
      ) {
        entries.push({ id, folder });
      }
    }
    return entries;
  }

  private write(projects: readonly ProjectEntry[]): void {
    const content: RegistryFile = { version: 1, projects };
    const dir = join(this.file, '..');
    mkdirSync(dir, { recursive: true });
    // Never overwrite a damaged list silently: keep it next to the new one for the user.
    if (this.damaged) {
      renameSync(this.file, `${this.file}.damaged-${Date.now()}`);
      this.damaged = false;
    }
    const temp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(temp, `${JSON.stringify(content, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temp, this.file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
