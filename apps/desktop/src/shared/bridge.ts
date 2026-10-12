/**
 * The contract between the preload script and the page (`window.moatDesktop`). Mirrored in
 * apps/web/src/app/core/desktop/desktop-bridge.ts — keep both in step.
 */
export const IPC = {
  projectAdd: 'moat:project:add',
  projectReveal: 'moat:project:reveal',
} as const;

/** A project id as the API hands it out (22 characters base64url). */
export const PROJECT_ID = /^[A-Za-z0-9_-]{22}$/;

export type ProjectAddResult =
  | { status: 'added'; id: string }
  | { status: 'cancelled' }
  | { status: 'failed' };

export interface DesktopBridge {
  readonly platform: string;
  readonly project: {
    /** The main process's folder dialog (DT-08: the page never names a path). */
    add(): Promise<ProjectAddResult>;
    /** Shows a listed project's folder in the file manager. */
    reveal(id: string): Promise<void>;
  };
}
