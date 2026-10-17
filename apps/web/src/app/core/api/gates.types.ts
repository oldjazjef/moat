/** The Cloud API's views of a project's gates (`apps/api/src/cloud/gates`); mirrors, not imports. */
export interface ConfigView {
  /** null: the project has no moat.yaml yet. */
  readonly text: string | null;
  readonly revision: number;
  /** SHA-256 hex of the text: what a change is based on. */
  readonly hash: string | null;
}

/** `managed`: trust mode 0 (Bequem). `signed`: the customer's key signs (Signiert). */
export type GateMode = 'managed' | 'signed';

export interface GateView {
  readonly name: string;
  readonly gateId: string;
  readonly mode: GateMode;
  readonly boxKeyFingerprint: string;
  readonly signerFingerprint: string | null;
  readonly hasPullAddress: boolean;
  readonly latestVersion: number;
  readonly createdAt: string;
}

export interface PublicKeyInfo {
  readonly kid: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** The key Moat Cloud signs with; during a rotation also the announced and the retired one. */
export interface SignerInfo extends PublicKeyInfo {
  readonly next: PublicKeyInfo | null;
  readonly previous: PublicKeyInfo | null;
}

export interface GatesAnswer {
  readonly gates: readonly GateView[];
  readonly signer: SignerInfo | null;
}

export interface SecretView {
  readonly name: string;
  readonly secretVersion: number;
  readonly updatedAt: string;
}

export interface FieldChange {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface BundleChange {
  readonly kind: 'route' | 'upstream' | 'secret' | 'lock';
  readonly name: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly fields: readonly FieldChange[];
}

export interface ReleasePreview {
  readonly gate: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly locked: boolean;
  readonly changes: readonly BundleChange[];
  readonly digest: string;
}
