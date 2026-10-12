/**
 * The contract between the preload script and the page (`window.moatDesktop`). Mirrored in
 * apps/web/src/app/core/desktop/desktop-bridge.ts — keep both in step.
 */
export const IPC = {
  projectAdd: 'moat:project:add',
  projectReveal: 'moat:project:reveal',
  bundleSign: 'moat:bundle:sign',
  secretSeal: 'moat:secret:seal',
} as const;

/** A project id as the API hands it out (22 characters base64url). */
export const PROJECT_ID = /^[A-Za-z0-9_-]{22}$/;

export type ProjectAddResult =
  | { status: 'added'; id: string }
  | { status: 'cancelled' }
  | { status: 'failed' };

/** A gate's (or route's, upstream's, secret's) name in the project (`gates/<name>.json`). */
export const GATE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export type BundleSignRefusal =
  'config_missing' | 'config_invalid' | 'gate_unknown' | 'secrets_missing';

export type BundleSignResult =
  | { status: 'signed'; version: number }
  | { status: 'cancelled' }
  /** Nothing to sign yet: `secrets` names what is not sealed for the gate (secrets_missing). */
  | { status: 'refused'; code: BundleSignRefusal; secrets: string[] }
  /** Signed, but `bundles/<gate>/` could not be written. */
  | { status: 'not_writable' }
  | { status: 'failed' };

export type SecretSealResult =
  | { status: 'sealed'; secretVersion: number }
  | { status: 'cancelled' }
  | {
      status: 'refused';
      code:
        | 'config_missing'
        | 'config_invalid'
        | 'gate_unknown'
        | 'secret_unknown'
        | 'secret_unreadable';
    }
  /** `secrets/<gate>/` could not be written; nothing was saved. */
  | { status: 'not_writable' }
  | { status: 'failed' };

export interface DesktopBridge {
  readonly platform: string;
  readonly project: {
    /** The main process's folder dialog (DT-08: the page never names a path). */
    add(): Promise<ProjectAddResult>;
    /** Shows a listed project's folder in the file manager. */
    reveal(id: string): Promise<void>;
  };
  readonly bundle: {
    /**
     * Opens the main process's signing dialog for the gate's next bundle (DT-15): the person sees
     * what changes, gives the passphrase and confirms there. The page only learns the outcome.
     */
    sign(
      projectId: string,
      gate: string,
      /** The page's language (`de-CH` | `en`): the dialog speaks it too. */
      locale: string,
    ): Promise<BundleSignResult>;
  };
  readonly secret: {
    /**
     * Opens the main process's seal window for a secret of a gate: the person checks the gate's
     * fingerprint and types the value there, never in the page. The page learns only the outcome.
     */
    seal(
      projectId: string,
      gate: string,
      name: string,
      locale: string,
    ): Promise<SecretSealResult>;
  };
}
