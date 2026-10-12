/**
 * The contract between the main process and the signing dialog's preload (DT-15). The dialog is
 * its own window with its own preload and no page script: the preload renders this view with
 * `textContent` only and sends back what the person did. Nothing here reaches the app's page.
 */
export const SIGN_IPC = {
  /** () → SignDialogView */
  view: 'moat:sign-dialog:view',
  /** () → SignDialogView | null: the file dialog for another key file (null: window closes). */
  chooseKey: 'moat:sign-dialog:choose-key',
  /** (SignDialogConfirm) → SignDialogView | null (null: signed, the window closes). */
  confirm: 'moat:sign-dialog:confirm',
  /** () → void */
  cancel: 'moat:sign-dialog:cancel',
} as const;

export interface SignDialogConfirm {
  /** Empty: use the passphrase remembered in the keychain. */
  readonly passphrase: string;
  /** Remember (or keep) the passphrase in the keychain; false forgets it. */
  readonly remember: boolean;
}

export type SignNotice =
  /** The project changed while the dialog was open: this is the new preview. */
  | 'changed'
  | 'keyfile_locked'
  | 'keyfile_invalid'
  /** The remembered passphrase no longer opens the key file: it was forgotten. */
  | 'remembered_failed'
  | 'key_unreadable'
  | 'key_missing'
  | 'passphrase_missing';

export interface SignDialogChange {
  readonly kind: 'route' | 'upstream' | 'secret' | 'lock';
  readonly name: string;
  readonly change: 'added' | 'removed' | 'changed';
  /** Field by field; a secret shows its version only, never a value. */
  readonly fields: readonly {
    readonly field: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
}

export interface SignDialogView {
  readonly texts: SignDialogTexts;
  readonly project: string;
  readonly gate: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly locked: boolean;
  readonly changes: readonly SignDialogChange[];
  /**
   * `unverified`: the latest bundle is not one the chosen key signed for this gate, so every entry
   * shows as new (a planted bundle file must not hide a change, T-53).
   */
  readonly previous: 'none' | 'verified' | 'unverified';
  /** The chosen key file: its file name and the kid it names (shown, not trusted). */
  readonly keyFile: {
    readonly name: string;
    readonly kid: string | null;
  } | null;
  /** A passphrase for this key is in the keychain. */
  readonly remembered: boolean;
  /** The OS keychain can be used (Electron safeStorage). */
  readonly canRemember: boolean;
  readonly notice: SignNotice | null;
}

/** The dialog's texts in the system language (apps/desktop/src/main/lib/messages.ts). */
export interface SignDialogTexts {
  readonly title: string;
  readonly intro: string;
  readonly project: string;
  readonly gate: string;
  readonly version: string;
  readonly firstVersion: string;
  readonly changes: string;
  readonly noChanges: string;
  readonly kinds: Readonly<Record<SignDialogChange['kind'], string>>;
  readonly change: Readonly<Record<SignDialogChange['change'], string>>;
  readonly lockAdded: string;
  readonly lockRemoved: string;
  readonly lockedWarning: string;
  readonly unverified: string;
  /** Shown for a field that was or is not set. */
  readonly unset: string;
  readonly keyFile: string;
  readonly noKeyFile: string;
  readonly chooseKey: string;
  readonly passphrase: string;
  readonly passphraseRemembered: string;
  readonly remember: string;
  readonly sign: string;
  readonly cancel: string;
  readonly notices: Readonly<Record<SignNotice, string>>;
}
