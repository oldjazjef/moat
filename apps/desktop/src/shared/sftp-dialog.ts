/**
 * The contract between the main process and the SFTP window (DT-05). Host, user and the password
 * or key passphrase are typed only in this window, never in the app's page; the main process
 * connects, and the page learns only the outcome. Like the other dialogs it has no page script:
 * the preload renders with `textContent` only.
 */
export const SFTP_IPC = {
  /** () → SftpDialogView */
  view: 'moat:sftp-dialog:view',
  /** () → SftpDialogView: the main process's file dialog for an OpenSSH private key. */
  chooseKey: 'moat:sftp-dialog:choose-key',
  /** (SftpDialogInput) → SftpDialogView | null (null: uploaded, the window closes). */
  connect: 'moat:sftp-dialog:connect',
  /** () → SftpDialogView | null: the person compared the host key and trusts it. */
  trustHostKey: 'moat:sftp-dialog:trust-host-key',
  /** () → SftpDialogView: drops the saved target of this gate (and its pinned host key). */
  forget: 'moat:sftp-dialog:forget',
  /** () → void */
  cancel: 'moat:sftp-dialog:cancel',
} as const;

export type SftpAuth = 'password' | 'key';

export interface SftpDialogInput {
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly remoteDir: string;
  readonly auth: SftpAuth;
  /** The password, or the private key's passphrase; empty: the remembered one, or none. */
  readonly secret: string;
  readonly remember: boolean;
}

export type SftpNotice =
  | 'target_invalid'
  | 'key_missing'
  | 'key_unreadable'
  | 'secret_missing'
  | 'connect_failed'
  | 'auth_failed'
  | 'hostkey_changed'
  | 'exists'
  | 'upload_failed'
  | 'forgotten';

export interface SftpDialogView {
  readonly texts: SftpDialogTexts;
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  readonly version: number;
  /** The package's files, as they will be on the server. */
  readonly files: readonly string[];
  /** `target`: where and as whom; `hostkey`: compare the server's key before anything is sent. */
  readonly step: 'target' | 'hostkey';
  readonly target: {
    readonly host: string;
    readonly port: string;
    readonly username: string;
    readonly remoteDir: string;
    readonly auth: SftpAuth;
    /** The chosen private key's file name (never its path or content). */
    readonly keyName: string | null;
    readonly secretRemembered: boolean;
    /** The pinned host key, when this target has one. */
    readonly hostKey: string | null;
  };
  /** Only with a real OS keychain (DT-04): otherwise nothing is remembered. */
  readonly canRemember: boolean;
  /** For `hostkey`: the key the server showed. */
  readonly hostKey: string | null;
  readonly notice: SftpNotice | null;
}

export interface SftpDialogTexts {
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
  readonly auth: string;
  readonly authPassword: string;
  readonly authKey: string;
  readonly keyFile: string;
  readonly noKeyFile: string;
  readonly chooseKey: string;
  readonly password: string;
  readonly passphrase: string;
  readonly secretRemembered: string;
  readonly remember: string;
  readonly pinned: string;
  readonly upload: string;
  readonly forget: string;
  readonly cancel: string;
  readonly hostKeyTitle: string;
  readonly hostKeyIntro: string;
  readonly hostKeyHint: string;
  readonly trust: string;
  readonly notices: Readonly<Record<SftpNotice, string>>;
}
