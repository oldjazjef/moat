/**
 * The desktop shell's API (`window.moatDesktop`, exposed by apps/desktop's preload script).
 * Absent in a browser. A mirror of `apps/desktop/src/shared/bridge.ts` — keep both in step; the
 * web app must not import from apps/desktop.
 */
export type ProjectAddResult =
  | { status: 'added'; id: string }
  | { status: 'cancelled' }
  | { status: 'failed' };

export interface DesktopBridge {
  readonly platform: string;
  readonly project: {
    /** Opens the folder dialog of the main process (DT-08: the page never names a path). */
    add(): Promise<ProjectAddResult>;
    /** Shows a listed project's folder in the file manager. */
    reveal(id: string): Promise<void>;
  };
}

declare global {
  interface Window {
    moatDesktop?: DesktopBridge;
  }
}

/** The bridge when running inside Moat Desktop, otherwise null. */
export function desktopBridge(): DesktopBridge | null {
  return window.moatDesktop ?? null;
}
