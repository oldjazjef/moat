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
  /** Gates moat.yaml locks, on their own or with their environment. */
  readonly gatesLocked: readonly string[];
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
  /**
   * SHA-256 (hex) of moat.yaml as read for this view; null when there is none. An edit names it
   * as its `base`, so a file changed on disk in the meantime is never overwritten (409).
   */
  readonly configHash: string | null;
}

/**
 * The edits Moat Desktop makes to moat.yaml (`POST /api/projects/:id/config/edits`): a closed list,
 * each one a function of `@moat/core` (config/edit.ts) that keeps comments and key order. No
 * free text reaches the file: only names that match the name pattern (SEC-20).
 */
export const CONFIG_EDIT_OPS = [
  'addEnvironment',
  'lockEnvironment',
  'unlockEnvironment',
  'lockGate',
  'unlockGate',
  'assignGate',
] as const;
export type ConfigEditOp = (typeof CONFIG_EDIT_OPS)[number];

export type ConfigEdit =
  | {
      readonly op: 'addEnvironment' | 'lockEnvironment' | 'unlockEnvironment';
      readonly environment: string;
    }
  | { readonly op: 'lockGate' | 'unlockGate'; readonly gate: string }
  | {
      readonly op: 'assignGate';
      readonly gate: string;
      readonly environment: string;
    };

/** Why an edit was refused (422), as `{ error: <code> }`; the UI shows `edit.errors.<code>`. */
export type ConfigEditRefusal =
  | 'config_missing'
  | 'config_invalid'
  | 'name_invalid'
  | 'environment_unknown'
  | 'gate_in_other_environment'
  | 'not_writable';
