import { Command, Query } from '@nestjs/cqrs';
import type { BundleChange, BundlePlanErrorCode } from '@moat/core';
import type {
  ConfigEdit,
  ConfigEditRefusal,
} from '../../../project/project.types';
import type {
  Forbidden,
  NotFound,
} from '../../tenancy/application/tenancy.commands';
import type { GateMode } from '../ports/gates.ports';
import type { SignerInfo } from './cloud-signer';

export type { Forbidden, NotFound };

// ── Config ─────────────────────────────────────────────────────────────────────────────────

export interface ConfigView {
  /** null: the project has no moat.yaml yet. */
  readonly text: string | null;
  /** 0 when there is none. */
  readonly revision: number;
  /** SHA-256 hex of the text (what an edit is based on); null when there is none. */
  readonly hash: string | null;
}

export type GetConfigResult =
  ({ readonly status: 'ok' } & ConfigView) | NotFound | Forbidden;

export class GetConfigQuery extends Query<GetConfigResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
  ) {
    super();
  }
}

export type SaveConfigResult =
  | ({ readonly status: 'ok' } & ConfigView)
  | NotFound
  | Forbidden
  /** moat.yaml changed since `base`: nothing written (409). */
  | { readonly status: 'changed' }
  | {
      readonly status: 'refused';
      readonly code: ConfigEditRefusal | 'config_too_large';
      readonly fields?: readonly string[];
    };

/** Replaces moat.yaml as a whole (a text editor); `base` null = creating it. */
export class SetConfigCommand extends Command<SaveConfigResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly text: string,
    readonly base: string | null,
  ) {
    super();
  }
}

/** One edit of the closed list (the same as Moat Desktop's), based on the hash the caller saw. */
export class EditConfigCommand extends Command<SaveConfigResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly base: string,
    readonly edit: ConfigEdit,
  ) {
    super();
  }
}

// ── Gates ──────────────────────────────────────────────────────────────────────────────────

export interface GateView {
  readonly name: string;
  readonly gateId: string;
  readonly mode: GateMode;
  /** `MOAT-…` of the gate's box key: compared with what the gate printed (SEC-32). */
  readonly boxKeyFingerprint: string;
  /**
   * Whose key signs its bundles: Moat Cloud's installation key (`managed`) or the pinned customer
   * key (`signed`). Null: managed, but this installation has no signing key.
   */
  readonly signerFingerprint: string | null;
  readonly hasPullAddress: boolean;
  /** 0 when no bundle yet. */
  readonly latestVersion: number;
  readonly createdAt: string;
}

export type ListGatesResult =
  | {
      readonly status: 'ok';
      readonly gates: readonly GateView[];
      /** The installation's signing key for managed gates; null when there is none. */
      readonly signer: SignerInfo | null;
    }
  | NotFound
  | Forbidden;

export class ListGatesQuery extends Query<ListGatesResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
  ) {
    super();
  }
}

export type AddGateResult =
  | { readonly status: 'ok'; readonly gate: GateView }
  | NotFound
  | Forbidden
  | {
      readonly status: 'refused';
      readonly code:
        | 'name_invalid'
        | 'gate_id_invalid'
        | 'box_key_invalid'
        | 'fingerprint_mismatch'
        | 'signer_key_invalid'
        | 'signer_not_allowed'
        | 'managed_unavailable'
        | 'gate_exists'
        | 'gate_limit';
    };

/**
 * Enrols a gate (SEC-32): its id and box key as `php moat-gate.php install` printed them, plus the
 * fingerprint the person compared with the gate's own display. A mismatch refuses: a key the Cloud
 * made up cannot be slipped in. `signerKey` (base64url Ed25519 public key) makes it a `signed` gate.
 */
export class AddGateCommand extends Command<AddGateResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly name: string,
    readonly gateId: string,
    readonly boxKey: string,
    readonly fingerprint: string,
    readonly signerKey: string | null,
  ) {
    super();
  }
}

export type PullAddressResult =
  /** The address is shown once; only a hash of its token is kept. */
  { readonly status: 'ok'; readonly url: string } | NotFound | Forbidden;

export class CreatePullAddressCommand extends Command<PullAddressResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly gate: string,
  ) {
    super();
  }
}

// ── Secrets ────────────────────────────────────────────────────────────────────────────────

export interface SecretView {
  readonly name: string;
  readonly secretVersion: number;
  readonly updatedAt: string;
}

export type ListSecretsResult =
  | { readonly status: 'ok'; readonly secrets: readonly SecretView[] }
  | NotFound
  | Forbidden;

export class ListSecretsQuery extends Query<ListSecretsResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly gate: string,
  ) {
    super();
  }
}

/** The sealed secret as the client built it (`moat secret seal`, Moat Desktop). */
export interface SealedInput {
  readonly v: number;
  readonly alg: string;
  readonly secretVersion: number;
  readonly epk: string;
  readonly nonce: string;
  readonly ct: string;
}

export type PutSecretResult =
  | { readonly status: 'ok'; readonly secret: SecretView }
  | NotFound
  | Forbidden
  | {
      readonly status: 'refused';
      readonly code:
        'name_invalid' | 'secret_invalid' | 'version_stale' | 'secret_limit';
    };

export class PutSecretCommand extends Command<PutSecretResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly gate: string,
    readonly name: string,
    readonly sealed: SealedInput,
  ) {
    super();
  }
}

// ── Releases ───────────────────────────────────────────────────────────────────────────────

export interface ReleasePreview {
  readonly gate: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly locked: boolean;
  readonly changes: readonly BundleChange[];
  /** Binds the confirmation to exactly this bundle: signing refuses when the input changed. */
  readonly digest: string;
}

type ReleaseRefusal =
  | { readonly code: 'not_managed' | 'managed_unavailable' | 'not_signed' }
  | {
      readonly code: BundlePlanErrorCode;
      /** For `secrets_missing`. */
      readonly secrets: readonly string[];
    };

export type PreviewReleaseResult =
  | { readonly status: 'ok'; readonly preview: ReleasePreview }
  | NotFound
  | Forbidden
  | ({ readonly status: 'refused' } & ReleaseRefusal);

export class PreviewReleaseQuery extends Query<PreviewReleaseResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly gate: string,
  ) {
    super();
  }
}

export type ReleaseResult =
  | {
      readonly status: 'ok';
      readonly version: number;
      readonly kid: string;
      readonly sha256: string;
    }
  | NotFound
  | Forbidden
  /** The input changed after the preview (or a racing release took the version): nothing signed. */
  | { readonly status: 'changed' }
  | ({ readonly status: 'refused' } & ReleaseRefusal);

/** Moat Cloud signs the gate's next bundle (trust mode 0) — needs the release permission. */
export class ReleaseCommand extends Command<ReleaseResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly gate: string,
    readonly digest: string,
  ) {
    super();
  }
}

export type UploadBundleResult =
  | { readonly status: 'ok'; readonly version: number; readonly sha256: string }
  | NotFound
  | Forbidden
  | {
      readonly status: 'refused';
      readonly code: 'not_signed' | 'bundle_invalid';
    }
  | { readonly status: 'changed' };

/** A bundle signed elsewhere (CLI, Moat Desktop, a signer service); verified against the pinned key. */
export class UploadBundleCommand extends Command<UploadBundleResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly gate: string,
    readonly envelope: string,
  ) {
    super();
  }
}

/** The gate's pull: the latest bundle for the token in the address; null for anything else. */
export class PullBundleQuery extends Query<string | null> {
  constructor(readonly token: string) {
    super();
  }
}
