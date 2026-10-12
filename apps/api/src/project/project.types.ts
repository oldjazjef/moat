import type { ProjectState } from '@moat/core';

/**
 * A project Moat Desktop knows: an id of its own and the folder the project lives in (DT-03,
 * DT-14). The list of these is the API's only own data; the projects stay in their folders.
 */
export interface ProjectEntry {
  /** 22 characters base64url (16 random bytes): stable while the project is in the list. */
  readonly id: string;
  /** Absolute path, chosen in the desktop's own folder dialog (DT-08), never by the page. */
  readonly folder: string;
}

/** The id format; anything else is answered like an unknown project (404). */
export const PROJECT_ID = /^[A-Za-z0-9_-]{22}$/;

/** One card of the project list (`GET /api/projects`). Never a secret or ciphertext. */
export interface ProjectSummary {
  readonly id: string;
  /** The folder's own name. */
  readonly name: string;
  readonly folder: string;
  /** The state of moat.yaml; null when the folder can no longer be read. */
  readonly config: 'valid' | 'invalid' | 'missing' | null;
  readonly routes: number;
  readonly gates: number;
  /** Gates that still lack a secret the config uses. */
  readonly gatesMissingSecrets: readonly string[];
}

/**
 * One project (`GET /api/projects/:id`). `project` is null when the folder can no longer be read
 * (moved, deleted, unplugged). Never contains a secret or ciphertext (SEC-31).
 */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly project: ProjectState | null;
}
