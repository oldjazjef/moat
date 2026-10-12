/**
 * The contract between the preload script and the page (`window.moatDesktop`). Mirrored in
 * apps/web/src/app/core/desktop/desktop-bridge.ts — keep both in step.
 */
export const IPC = {
  projectChoose: 'moat:project:choose',
  projectReveal: 'moat:project:reveal',
} as const;

export type ProjectChangeResult =
  | { status: 'cancelled' }
  | { status: 'unchanged' }
  | { status: 'restarting' }
  | { status: 'failed' };

export interface DesktopBridge {
  readonly platform: string;
  readonly project: {
    choose(): Promise<ProjectChangeResult>;
    reveal(): Promise<void>;
  };
}
