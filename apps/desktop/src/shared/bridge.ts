/**
 * The contract between the preload script and the page (`window.moatDesktop`). Mirrored in
 * apps/web/src/app/core/desktop/desktop-bridge.ts — keep both in step.
 */
export const IPC = {
  projectAdd: 'moat:project:add',
  projectCreate: 'moat:project:create',
  keyStatus: 'moat:key:status',
  keyChoose: 'moat:key:choose',
  keyRotationDone: 'moat:key:rotation-done',
  keyCreate: 'moat:key:create',
  projectReveal: 'moat:project:reveal',
  bundleSign: 'moat:bundle:sign',
  secretSeal: 'moat:secret:seal',
  gateDeploy: 'moat:gate:deploy',
  gateImport: 'moat:gate:import',
  gateLog: 'moat:gate:log',
  databaseOpen: 'moat:database:open',
} as const;

/** A project id as the API hands it out (22 characters base64url). */
export const PROJECT_ID = /^[A-Za-z0-9_-]{22}$/;

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
  /** `previous`: the key an open rotation (SEC-08) replaces; null when none is open. */
  | { status: 'ready'; key: SigningKeyInfo; previous: SigningKeyInfo | null }
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

/**
 * Where a deploy package goes (DT-05): a ZIP file, a new folder inside a chosen one, or a new
 * folder on a server over SFTP or FTPS, or a new folder committed and pushed in a Git working copy.
 */
export type DeployTarget = 'zip' | 'folder' | 'sftp' | 'ftps' | 'git';
export const DEPLOY_TARGETS: readonly DeployTarget[] = [
  'zip',
  'folder',
  'sftp',
  'ftps',
  'git',
];

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
export const IMPORT_FROM: readonly ImportFrom[] = ['file', 'folder'];

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

/** One line of a gate's request log (FR-50): never a path, a body or an address. */
export interface RequestLogLine {
  /** Unix seconds. */
  t: number;
  route: string | null;
  method: string;
  status: number;
  /** The gate's error code; null when the upstream answered. */
  error: string | null;
  ms: number;
  /** The same for one client on one UTC day. */
  client: string;
}

/** «Log ansehen» (DT-12): the summary of the files the person chose, and the newest lines. */
export interface RequestLogView {
  requests: number;
  errors: number;
  clients: number;
  from: number | null;
  to: number | null;
  codes: { code: string; count: number }[];
  routes: {
    route: string | null;
    requests: number;
    errors: number;
    p50Ms: number;
    p95Ms: number;
  }[];
  /** Newest first, at most 200. */
  recent: RequestLogLine[];
  /** Lines that were no log entry. */
  skipped: number;
}

/**
 * `unreadable` / `too_large`: a chosen file cannot be read or is too big; `no_entries`: nothing
 * in them is a line of a gate's request log.
 */
export type RequestLogRefusal = 'unreadable' | 'too_large' | 'no_entries';

export type RequestLogResult =
  | { status: 'read'; log: RequestLogView }
  | { status: 'cancelled' }
  | { status: 'refused'; code: RequestLogRefusal }
  | { status: 'failed' };

/**
 * «Externe Datenbank» (DT-03, DT-13): what the page learns of the database window — counts only;
 * the connection string and the issues' details stay in the window.
 */
export type DatabaseResult =
  | {
      status: 'done';
      direction: 'push' | 'pull';
      /** moat.yaml was written. */
      config: boolean;
      gates: number;
      secrets: number;
      bundles: number;
      /** Conflicts and notes the window listed; nothing was overwritten for them. */
      issues: number;
    }
  | { status: 'cancelled' }
  | { status: 'failed' };

export interface DesktopBridge {
  readonly platform: string;
  readonly project: {
    /** The main process's folder dialog (DT-08: the page never names a path). */
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
    /** SEC-08: every gate pins the new key alone now; the desktop forgets the old key. */
    rotationDone(): Promise<boolean>;
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
    /**
     * «Log ansehen» (FR-50, DT-12): the main process's dialog chooses the gate's log files
     * (`log.php`, `logold.php`) or what `php moat-gate.php log` printed; the page gets the
     * summary and the newest lines, never a path.
     */
    log(
      projectId: string,
      gate: string,
      locale: string,
    ): Promise<RequestLogResult>;
  };
  /**
   * Opens the main process's database window for the project (DT-03): the connection string is
   * typed there, never in the page, and the page learns only the counts. Optional only so test
   * doubles need not stub it; the desktop's preload always provides it.
   */
  readonly database?: {
    open(projectId: string, locale: string): Promise<DatabaseResult>;
  };
}
