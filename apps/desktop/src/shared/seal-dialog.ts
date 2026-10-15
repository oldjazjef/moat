/**
 * The contract between the main process and the seal dialog's preload. The secret's value is
 * typed only in this window (never in the app's page), goes to the main process as bytes and is
 * sealed in-process; the page learns only the outcome (SEC-31). Like the signing dialog it has
 * no page script: the preload renders with `textContent` only.
 */
export const SEAL_IPC = {
  /** () → SealDialogView */
  view: 'moat:seal-dialog:view',
  /** (SealDialogConfirm) → SealDialogView | null (null: sealed, the window closes). */
  confirm: 'moat:seal-dialog:confirm',
  /** () → void */
  cancel: 'moat:seal-dialog:cancel',
} as const;

export interface SealDialogConfirm {
  /** The value as UTF-8; the main process zeroes it after sealing. */
  readonly value: Uint8Array;
}

export type SealNotice =
  /** Empty, too long, a line break or NUL. */
  | 'value_invalid'
  /** The gate's key or the secret's version changed while the window was open. */
  | 'changed';

export interface SealDialogView {
  readonly texts: SealDialogTexts;
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  /** Of the gate's box key: what the gate printed at install (SEC-32). */
  readonly fingerprint: string;
  readonly name: string;
  readonly currentVersion: number | null;
  readonly nextVersion: number;
  readonly usedBy: readonly {
    readonly upstream: string;
    readonly origin: string;
  }[];
  /** Routes that compare a caller's API key with the value (FR-16). */
  readonly comparedBy: readonly string[];
  readonly notice: SealNotice | null;
}

export interface SealDialogTexts {
  readonly title: string;
  readonly intro: string;
  readonly project: string;
  readonly gate: string;
  readonly fingerprint: string;
  readonly fingerprintHint: string;
  readonly secret: string;
  readonly version: string;
  readonly firstVersion: string;
  readonly usedBy: string;
  readonly unused: string;
  readonly comparedBy: string;
  readonly value: string;
  readonly valueHint: string;
  readonly show: string;
  readonly seal: string;
  readonly cancel: string;
  readonly notices: Readonly<Record<SealNotice, string>>;
}
