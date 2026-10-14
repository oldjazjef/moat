/**
 * The contract between the main process and the FTPS window (DT-05, T-69). Host, user and
 * password are typed only in this window, never in the app's page; the main process connects
 * (always over TLS) and the page learns only the outcome. Like the other dialogs it has no page
 * script: the preload renders with `textContent` only.
 */
export const FTPS_IPC = {
  /** () → FtpsDialogView */
  view: 'moat:ftps-dialog:view',
  /** (FtpsDialogInput) → FtpsDialogView | null (null: uploaded, the window closes). */
  connect: 'moat:ftps-dialog:connect',
  /** () → FtpsDialogView | null: the person compared the certificate and trusts it. */
  trustCertificate: 'moat:ftps-dialog:trust-certificate',
  /** () → FtpsDialogView: drops the saved target of this gate (and its pinned certificate). */
  forget: 'moat:ftps-dialog:forget',
  /** () → void */
  cancel: 'moat:ftps-dialog:cancel',
} as const;

/**
 * `explicit`: plain connect, then `AUTH TLS` before anything else (usually port 21);
 * `implicit`: TLS from the first byte (usually port 990). Plain FTP is never an option.
 */
export type FtpsMode = 'explicit' | 'implicit';

export interface FtpsDialogInput {
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly remoteDir: string;
  readonly mode: FtpsMode;
  /** The password; empty: the remembered one. */
  readonly secret: string;
  readonly remember: boolean;
}

export type FtpsNotice =
  | 'target_invalid'
  | 'secret_missing'
  | 'connect_failed'
  | 'tls_failed'
  | 'auth_failed'
  | 'certificate_changed'
  | 'exists'
  | 'partial'
  | 'upload_failed'
  | 'forgotten';

/** The server's TLS certificate as the person compares it (T-69). */
export interface FtpsCertificate {
  /** `SHA256:AB:CD:…` (the SHA-256 of the certificate, as browsers and `openssl x509` show it). */
  readonly fingerprint: string;
  /** `CN=…, O=…`, printable characters only. */
  readonly subject: string;
  readonly issuer: string;
  /** As the certificate says, e.g. `Oct 14 12:00:00 2027 GMT`. */
  readonly validTo: string;
}

export interface FtpsDialogView {
  readonly texts: FtpsDialogTexts;
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  readonly version: number;
  /** The package's files, as they will be on the server. */
  readonly files: readonly string[];
  /** `target`: where and as whom; `certificate`: compare the server's certificate first. */
  readonly step: 'target' | 'certificate';
  readonly target: {
    readonly host: string;
    readonly port: string;
    readonly username: string;
    readonly remoteDir: string;
    readonly mode: FtpsMode;
    readonly secretRemembered: boolean;
    /** The pinned certificate's fingerprint, when this target has one. */
    readonly certificate: string | null;
  };
  /** Only with a real OS keychain (DT-04): otherwise nothing is remembered. */
  readonly canRemember: boolean;
  /** For `certificate`: the certificate the server showed. */
  readonly certificate: FtpsCertificate | null;
  readonly notice: FtpsNotice | null;
}

export interface FtpsDialogTexts {
  readonly title: string;
  readonly intro: string;
  readonly project: string;
  readonly gate: string;
  readonly version: string;
  readonly files: string;
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly remoteDir: string;
  readonly remoteDirHint: string;
  readonly mode: string;
  readonly modeExplicit: string;
  readonly modeImplicit: string;
  readonly modeHint: string;
  readonly password: string;
  readonly secretRemembered: string;
  readonly remember: string;
  readonly pinned: string;
  readonly upload: string;
  readonly forget: string;
  readonly cancel: string;
  readonly certificateTitle: string;
  readonly certificateIntro: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly issuer: string;
  readonly validTo: string;
  readonly certificateHint: string;
  readonly trust: string;
  readonly notices: Readonly<Record<FtpsNotice, string>>;
}
