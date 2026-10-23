/** `managed`: trust mode 0, Moat Cloud signs. `signed`: modes 1 to 3, the customer's key signs. */
export type GateMode = 'managed' | 'signed';

export interface ConfigRecord {
  readonly projectId: string;
  readonly text: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface GateRecord {
  readonly projectId: string;
  readonly name: string;
  readonly gateId: string;
  /** X25519 public key of the gate (base64url): what its secrets are sealed to. */
  readonly boxKey: string;
  readonly mode: GateMode;
  /** `signed` only: the customer's pinned Ed25519 public key and its key id. */
  readonly signerKid: string | null;
  readonly signerKey: string | null;
  /** SHA-256 hex of the token in the pull address; null: no pull address yet. */
  readonly pullTokenHash: string | null;
  readonly createdAt: string;
}

export interface SecretRecord {
  readonly projectId: string;
  readonly gate: string;
  readonly name: string;
  readonly secretVersion: number;
  /** The sealed secret as JSON text (ciphertext only, SEC-31). */
  readonly text: string;
  readonly updatedAt: string;
}

export interface BundleRecord {
  readonly projectId: string;
  readonly gate: string;
  readonly version: number;
  /** SHA-256 hex of `text`. */
  readonly digest: string;
  /** The envelope exactly as signed. */
  readonly text: string;
  readonly createdAt: string;
}

export type SetConfigOutcome = 'ok' | 'conflict';
export type AddGateOutcome = 'ok' | 'exists' | 'limit';
export type PutSecretOutcome = 'ok' | 'stale' | 'limit' | 'no_gate';
export type AddBundleOutcome = 'ok' | 'exists';

/** At most this many gates in a project, secrets in a gate. */
export const MAX_GATES = 20;
export const MAX_SECRETS = 64;

/**
 * Everything a Cloud project keeps besides its name: moat.yaml, its gates, their sealed secrets
 * and their signed bundles. Every method takes the project (the handler has checked it belongs to
 * the caller's organisation first, SEC-50). Nothing here updates or removes a bundle (SEC-04).
 */
export abstract class CloudProjectStorePort {
  abstract getConfig(projectId: string): Promise<ConfigRecord | null>;
  /**
   * Writes moat.yaml as revision `expectedRevision + 1`, atomically: `conflict` when the stored
   * revision is not `expectedRevision` (0 = no config yet).
   */
  abstract setConfig(
    projectId: string,
    text: string,
    expectedRevision: number,
    at: string,
  ): Promise<SetConfigOutcome>;

  abstract listGates(projectId: string): Promise<readonly GateRecord[]>;
  abstract findGate(
    projectId: string,
    name: string,
  ): Promise<GateRecord | null>;
  abstract addGate(gate: GateRecord): Promise<AddGateOutcome>;
  /**
   * Deletes the gate with its secrets, bundles and pull address in one step (the foreign keys
   * cascade); false when there was no such gate. The project's moat.yaml is not touched.
   */
  abstract removeGate(projectId: string, name: string): Promise<boolean>;
  abstract setPullTokenHash(
    projectId: string,
    name: string,
    hash: string,
  ): Promise<boolean>;
  /** The gate whose pull address holds the token with this hash. */
  abstract findGateByPullTokenHash(hash: string): Promise<GateRecord | null>;

  abstract listSecrets(
    projectId: string,
    gate: string,
  ): Promise<readonly SecretRecord[]>;
  /** Atomically: only a version higher than the stored one is written (`stale` otherwise). */
  abstract putSecret(secret: SecretRecord): Promise<PutSecretOutcome>;

  abstract latestBundle(
    projectId: string,
    gate: string,
  ): Promise<BundleRecord | null>;
  abstract addBundle(bundle: BundleRecord): Promise<AddBundleOutcome>;
}
