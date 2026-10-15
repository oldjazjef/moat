import type { SignDialogChange, SignDialogView } from './sign-dialog';

/**
 * The contract between the main process and the two passkey windows (trust mode 2,
 * docs/CRYPTO.md §7): «Passkey anlegen» and the signing dialog of a gate that signs with the
 * passkey. Like the other dialogs they have no page script: the preload renders the view with
 * `textContent` only. What is different: the preload also calls `navigator.credentials` — the
 * page it runs in is served from the passkey origin (lib/passkey.ts), and the challenge, the
 * credential id and the assertion travel only between this window and the main process. The
 * app's page never sees any of it.
 */

export const PASSKEY_ENROLL_IPC = {
  /** () → PasskeyEnrollView */
  view: 'moat:passkey-dialog:view',
  /** () → PasskeyCreateRequest | null: a fresh challenge for one ceremony. */
  begin: 'moat:passkey-dialog:begin',
  /** (PasskeyEnrollOutcome) → PasskeyEnrollView | null (null: the window closes). */
  finish: 'moat:passkey-dialog:finish',
  /** () → void */
  cancel: 'moat:passkey-dialog:cancel',
} as const;

export const PASSKEY_SIGN_IPC = {
  /** () → PasskeySignView */
  view: 'moat:passkey-sign-dialog:view',
  /** () → PasskeySignBegin | null */
  begin: 'moat:passkey-sign-dialog:begin',
  /** (PasskeyAssertionOutcome) → PasskeySignView | null (null: signed, the window closes). */
  deliver: 'moat:passkey-sign-dialog:deliver',
  /** () → void */
  cancel: 'moat:passkey-sign-dialog:cancel',
} as const;

/** Why `navigator.credentials` gave nothing: the person said no, no passkey, or an error. */
export type PasskeyFailure = 'cancelled' | 'unavailable' | 'failed';

/** What the preload passes to `navigator.credentials.create` (all binary values base64url). */
export interface PasskeyCreateRequest {
  readonly challenge: string;
  readonly rpId: string;
  readonly rpName: string;
  readonly userId: string;
  readonly userName: string;
  readonly timeoutMs: number;
}

export type PasskeyEnrollOutcome =
  | {
      readonly status: 'created';
      readonly attestationObject: string;
      readonly clientDataJSON: string;
    }
  | { readonly status: 'failed'; readonly reason: PasskeyFailure };

export type PasskeyEnrollNotice =
  | PasskeyFailure
  /** What the passkey returned did not check out (never stored). */
  | 'invalid'
  | 'not_writable';

/** The new passkey, public data only: what to pin on the gate. */
export interface PasskeyEnrollDone {
  readonly kid: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly rpId: string;
  readonly origin: string;
  /** `php moat-gate.php trust --passkey=… --rp-id=… --origin=…` */
  readonly trustCommand: string;
  /** The same for a new gate (`install`). */
  readonly installCommand: string;
}

export interface PasskeyEnrollView {
  readonly texts: PasskeyEnrollTexts;
  readonly rpId: string;
  readonly origin: string;
  /** A passkey exists already: the new one replaces it. */
  readonly replaces: boolean;
  readonly notice: PasskeyEnrollNotice | null;
  readonly done: PasskeyEnrollDone | null;
}

export interface PasskeyEnrollTexts {
  readonly title: string;
  readonly intro: string;
  readonly honesty: string;
  readonly rpId: string;
  readonly origin: string;
  readonly replaces: string;
  readonly create: string;
  readonly cancel: string;
  readonly close: string;
  readonly doneTitle: string;
  readonly doneIntro: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly trustCommand: string;
  readonly installCommand: string;
  readonly compare: string;
  readonly notices: Readonly<Record<PasskeyEnrollNotice, string>>;
}

/** What `navigator.credentials.get` is asked for (base64url). */
export interface PasskeyGetRequest {
  readonly challenge: string;
  readonly credentialId: string;
  readonly rpId: string;
  readonly timeoutMs: number;
}

export type PasskeySignBegin =
  | { readonly kind: 'view'; readonly view: PasskeySignView }
  | { readonly kind: 'request'; readonly request: PasskeyGetRequest };

export type PasskeyAssertionOutcome =
  | {
      readonly status: 'asserted';
      /** `PublicKeyCredential.rawId`: must be the stored passkey. */
      readonly credentialId: string;
      readonly authenticatorData: string;
      readonly clientDataJSON: string;
      readonly signature: string;
    }
  | { readonly status: 'failed'; readonly reason: PasskeyFailure };

export type PasskeySignNotice =
  | 'changed'
  | PasskeyFailure
  /** The assertion did not verify as the gate would (wrong credential, challenge, signature). */
  | 'assertion_invalid';

export interface PasskeySignView {
  readonly texts: PasskeySignTexts;
  readonly project: string;
  readonly gate: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly locked: boolean;
  readonly changes: readonly SignDialogChange[];
  readonly previous: SignDialogView['previous'];
  /** The passkey that will sign: its fingerprint, to compare with the one the gate pinned. */
  readonly fingerprint: string;
  readonly rpId: string;
  readonly notice: PasskeySignNotice | null;
}

export interface PasskeySignTexts {
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
  readonly unset: string;
  readonly passkey: string;
  readonly sign: string;
  readonly signing: string;
  readonly cancel: string;
  readonly notices: Readonly<Record<PasskeySignNotice, string>>;
}
