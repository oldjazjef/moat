/**
 * The contract between the main process and the key window («Neuen Schlüssel erstellen», FR-73).
 * The passphrase is typed only in this window, never in the app's page; the main process asks
 * where to save the key file, creates it in-process (Argon2id, docs/CRYPTO.md §6) and writes it.
 * The page learns only the public key. Like the other dialogs it has no page script: the preload
 * renders with `textContent` only.
 */
export const KEY_IPC = {
  /** () → KeyDialogView */
  view: 'moat:key-dialog:view',
  /** (KeyDialogConfirm) → KeyDialogView | null (null: created, the window closes). */
  confirm: 'moat:key-dialog:confirm',
  /** () → void */
  cancel: 'moat:key-dialog:cancel',
} as const;

/** As the CLI's `moat keygen`. */
export const MIN_PASSPHRASE = 12;
export const MAX_PASSPHRASE = 1024;

export interface KeyDialogConfirm {
  readonly passphrase: string;
  readonly repeat: string;
}

export type KeyNotice =
  | 'too_short'
  | 'too_long'
  | 'mismatch'
  /** A file is at the chosen place already: a key file is never overwritten. */
  | 'exists'
  | 'not_writable';

export interface KeyDialogView {
  readonly texts: KeyDialogTexts;
  readonly notice: KeyNotice | null;
}

export interface KeyDialogTexts {
  readonly title: string;
  readonly intro: string;
  readonly passphrase: string;
  readonly repeat: string;
  readonly hint: string;
  readonly show: string;
  readonly create: string;
  readonly working: string;
  readonly cancel: string;
  readonly notices: Readonly<Record<KeyNotice, string>>;
}
