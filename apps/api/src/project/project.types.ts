import type { ProjectState } from '@moat/core';

/**
 * `GET /api/project`. `folder` is where the project lives; `project` is null while no project is
 * open, or when the folder can no longer be read. Never contains a secret or ciphertext.
 */
export interface ProjectView {
  readonly folder: string | null;
  readonly project: ProjectState | null;
}
