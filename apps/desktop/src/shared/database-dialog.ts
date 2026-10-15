/**
 * The contract between the main process and the database window (DT-03, DT-13). The connection
 * string is typed only in this window, never in the app's page; the main process keeps it only as
 * keychain ciphertext (DT-04) and hands it to the API in-process. Like the other dialogs it has no
 * page script: the preload renders with `textContent` only.
 */
export const DATABASE_IPC = {
  /** () → DatabaseDialogView */
  view: 'moat:database-dialog:view',
  /** (DatabaseDialogInput) → DatabaseDialogView */
  run: 'moat:database-dialog:run',
  /** () → DatabaseDialogView: drops the remembered connection of this project. */
  forget: 'moat:database-dialog:forget',
  /** () → void: closes the window (with the last result, if any). */
  close: 'moat:database-dialog:close',
} as const;

export type DatabaseDirection = 'push' | 'pull';

export interface DatabaseDialogInput {
  /** The connection string; empty: the remembered one. */
  readonly url: string;
  /** The project's name in the database. */
  readonly key: string;
  readonly remember: boolean;
  readonly direction: DatabaseDirection;
}

export const DATABASE_NOTICES = [
  'url_missing',
  'url_invalid',
  'tls_required',
  'connect_failed',
  'foreign_tables',
  'schema_newer',
  'schema_damaged',
  'key_invalid',
  'key_missing',
  'config_missing',
  'changed',
  'not_writable',
  'failed',
  'forgotten',
] as const;
export type DatabaseNotice = (typeof DATABASE_NOTICES)[number];

/** core SYNC_ISSUES, as the window names them. */
export const DATABASE_ISSUES = [
  'config_conflict',
  'config_invalid',
  'gate_conflict',
  'gate_not_pinned',
  'secret_conflict',
  'secret_newer_elsewhere',
  'bundle_conflict',
  'bundle_newer_elsewhere',
  'bundle_unverified',
] as const;
export type DatabaseIssueCode = (typeof DATABASE_ISSUES)[number];

export interface DatabaseIssue {
  readonly code: DatabaseIssueCode;
  readonly gate: string | null;
  readonly name: string | null;
  readonly version: number | null;
}

export interface DatabaseSummary {
  readonly direction: DatabaseDirection;
  readonly key: string;
  readonly config: boolean;
  readonly gates: number;
  readonly secrets: number;
  readonly bundles: number;
  readonly issues: readonly DatabaseIssue[];
}

export interface DatabaseDialogView {
  readonly texts: DatabaseDialogTexts;
  readonly project: string;
  readonly target: {
    /** `postgresql://user@host:port/db` — never the password. */
    readonly label: string | null;
    readonly key: string;
    readonly urlRemembered: boolean;
  };
  /** Only with a real OS keychain (DT-04): otherwise the connection is not remembered. */
  readonly canRemember: boolean;
  readonly notice: DatabaseNotice | null;
  /** The last run's outcome, shown until the window closes. */
  readonly result: DatabaseSummary | null;
}

export interface DatabaseDialogTexts {
  readonly title: string;
  readonly intro: string;
  readonly project: string;
  readonly target: string;
  readonly url: string;
  readonly urlHint: string;
  readonly urlRemembered: string;
  readonly key: string;
  readonly keyHint: string;
  readonly remember: string;
  readonly push: string;
  readonly pull: string;
  readonly forget: string;
  readonly close: string;
  readonly resultTitle: Readonly<Record<DatabaseDirection, string>>;
  readonly resultConfig: string;
  readonly resultUnchanged: string;
  readonly resultGates: string;
  readonly resultSecrets: string;
  readonly resultBundles: string;
  readonly resultIssues: string;
  readonly notices: Readonly<Record<DatabaseNotice, string>>;
  readonly issues: Readonly<Record<DatabaseIssueCode, string>>;
}
