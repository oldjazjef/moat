/**
 * The desktop shell's API (`window.moatDesktop`, exposed by apps/desktop's preload script).
 * Absent in a browser. A mirror of `apps/desktop/src/shared/bridge.ts` — keep both in step; the
 * web app must not import from apps/desktop.
 */
export type ProjectAddResult =
  | { status: 'added'; id: string }
  | { status: 'cancelled' }
  | { status: 'failed' };

export type ProjectCreateResult =
  /** `created: false`: the folder had a moat.yaml already, which was kept. */
  | { status: 'added'; id: string; created: boolean }
  | { status: 'cancelled' }
  | { status: 'failed' };

/** The public half of the signing key (never the file's path, never anything secret). */
export interface SigningKeyInfo {
  kid: string;
  /** base64url: `php moat-gate.php install --signer=<publicKey>`. */
  publicKey: string;
  /** `MOAT-…`, what the gate prints as "Signer". */
  fingerprint: string;
}

export type SigningKeyStatus =
  | { status: 'ready'; key: SigningKeyInfo }
  /** No key file chosen yet. */
  | { status: 'none' }
  /** The chosen file is gone or is not a key file. */
  | { status: 'unreadable' };

export type SigningKeyResult =
  | { status: 'chosen' | 'created'; key: SigningKeyInfo }
  | { status: 'cancelled' }
  /** The chosen file is not a key file; the one before stays. */
  | { status: 'unreadable' }
  | { status: 'failed' };

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

/**
 * Where a deploy package goes (DT-05): a ZIP file, a new folder inside a chosen one, or a new
 * folder on a server over SFTP or FTPS, or a new folder committed and pushed in a Git working copy.
 */
export type DeployTarget = 'zip' | 'folder' | 'sftp' | 'ftps' | 'git';

/**
 * `key_missing`: no signing key chosen (or it cannot be read); `bundle_missing`: nothing signed
 * yet; `bundle_unverified`: the latest bundle is not one this key signed for this gate;
 * `gate_changed` / `bundle_older`: another gate id or a lower version than the last package of
 * this gate (T-66); `git_*`: the chosen folder cannot take a Git deploy (T-68).
 */
export type DeployRefusal =
  | 'key_missing'
  | 'gate_unknown'
  | 'bundle_missing'
  | 'bundle_unverified'
  | 'gate_changed'
  | 'bundle_older'
  | 'git_not_a_repo'
  | 'git_detached'
  | 'git_no_upstream'
  | 'git_ignored'
  | 'git_unsafe_config'
  | 'git_ahead';

export type DeployResult =
  | { status: 'exported'; target: DeployTarget; version: number }
  | { status: 'cancelled' }
  | { status: 'refused'; code: DeployRefusal }
  /** A folder of the package's name is there already (locally or on the server); nothing was written. */
  | { status: 'exists' }
  /** The chosen place could not be written; nothing was left behind. */
  | { status: 'not_writable' }
  /** Git: committed in the working copy, but the push failed (push by hand). */
  | { status: 'committed'; version: number }
  /** Git: `git add` or `git commit` failed; the package folder was removed again. */
  | { status: 'git_failed' }
  | { status: 'failed' };

/** What «Bundle importieren» opens (FR-45): a bundle file or package ZIP, or a package folder. */
export type ImportFrom = 'file' | 'folder';

/**
 * Why an import was refused (FR-45, DT-17): `key_missing`: no signing key chosen;
 * `unreadable` / `too_large`: the chosen file cannot be read or is too big; `package_invalid`: not
 * a deploy package as Moat writes it (unexpected or doubled files, links, unsafe ZIP entries);
 * `bundle_invalid`: not a well-formed bundle; `signature_invalid`: not signed with the desktop's
 * key; `gate_mismatch`: made for another gate; `version_not_newer`: not above the latest bundle;
 * `config_invalid`: its config breaks the schema.
 */
export type ImportRefusal =
  | 'key_missing'
  | 'gate_unknown'
  | 'unreadable'
  | 'too_large'
  | 'package_invalid'
  | 'bundle_invalid'
  | 'signature_invalid'
  | 'gate_mismatch'
  | 'version_not_newer'
  | 'config_invalid';

export type ImportResult =
  | { status: 'imported'; version: number }
  | { status: 'cancelled' }
  | { status: 'refused'; code: ImportRefusal }
  /** `bundles/<gate>/` could not be written; nothing was saved. */
  | { status: 'not_writable' }
  | { status: 'failed' };

export interface DesktopBridge {
  readonly platform: string;
  readonly project: {
    /** Opens the folder dialog of the main process (DT-08: the page never names a path). */
    add(): Promise<ProjectAddResult>;
    /**
     * «Neues Projekt»: the main process's folder dialog, then a new moat.yaml in that folder
     * (an existing one is kept), and the folder joins the list.
     */
    create(): Promise<ProjectCreateResult>;
    /** Shows a listed project's folder in the file manager. */
    reveal(id: string): Promise<void>;
  };
  readonly key: {
    /** The signing key the desktop uses (DT-15), by its public half. */
    status(): Promise<SigningKeyStatus>;
    /** The main process's file dialog for an existing `.moatkey` file. */
    choose(): Promise<SigningKeyResult>;
    /**
     * The main process's key window: the passphrase is typed there (twice), the file is saved
     * where the person chooses. The page learns only the public key.
     */
    create(locale: string): Promise<SigningKeyResult>;
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
  readonly gate: {
    /**
     * Saves the gate's deploy package (DT-05): the latest bundle signed with the desktop's key,
     * its policy and how to install them, as a ZIP or a new folder, where the person chooses in
     * the main process's dialog. The page never learns the path, only the outcome.
     */
    deploy(
      projectId: string,
      gate: string,
      target: DeployTarget,
      locale: string,
    ): Promise<DeployResult>;
    /**
     * Imports a bundle (FR-45): the main process's dialog chooses a `bundle-v<n>.json`, a deploy
     * package ZIP or folder; the bundle is checked as the gate would and saved byte for byte.
     * The page never learns the path, only the outcome.
     */
    import(
      projectId: string,
      gate: string,
      from: ImportFrom,
      locale: string,
    ): Promise<ImportResult>;
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
