import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  assembleEnvelope,
  buildBundle,
  buildBundlePayload,
  bundlePayloadBytes,
  pinnedSignerOf,
  verifyBundle,
  webauthnChallenge,
  webauthnSignature,
  BundlePlanError,
  canonicalJson,
  MoatRejection,
  openKeyFile,
  parseStrictJson,
  planBundle,
  type BundleChange,
  type BundlePlan,
  type BundlePlanErrorCode,
  type JsonValue,
  type PlanSigner,
} from '@moat/core';
import {
  BundleExistsError,
  ProjectFilesPort,
} from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';
import { HistoryService } from './history.service';
import { projectName } from './project-name';

/** What the signing dialog shows (DT-15): names and counts only, never a secret. */
export interface BundlePreview {
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly locked: boolean;
  readonly changes: readonly BundleChange[];
  /** Whether the changes are against a latest bundle signed with the chosen key. */
  readonly previous: BundlePlan['previous'];
  /** Binds the confirmation to exactly this bundle: sign() refuses when the input changed since. */
  readonly digest: string;
}

export type PrepareBundleResult =
  | { readonly status: 'ready'; readonly preview: BundlePreview }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'refused';
      readonly code: BundlePlanErrorCode;
      /** For `secrets_missing`. */
      readonly secrets: readonly string[];
    };

export type SignBundleResult =
  | {
      readonly status: 'signed';
      readonly version: number;
      readonly kid: string;
    }
  | { readonly status: 'not_found' }
  /** The project changed after the dialog opened: nothing signed, show the new preview. */
  | { readonly status: 'changed' }
  | { readonly status: 'refused'; readonly code: BundlePlanErrorCode }
  /** `keyfile_locked`: wrong passphrase; `keyfile_invalid`: not a Moat key file. */
  | {
      readonly status: 'key_refused';
      readonly code: 'keyfile_locked' | 'keyfile_invalid';
    }
  | { readonly status: 'not_writable' }
  /**
   * Passkey signing (trust mode 2): `cancelled`: no assertion came (the person cancelled, or the
   * system offered no passkey); `assertion_invalid`: the assertion does not verify as the gate
   * would verify it against the pinned passkey. Nothing is written in either case.
   */
  | {
      readonly status: 'passkey_refused';
      readonly code: 'cancelled' | 'assertion_invalid';
    };

/** What `navigator.credentials.get` returned, as bytes (docs/CRYPTO.md §7.2). */
export interface PasskeyAssertion {
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly signature: Uint8Array;
}

/**
 * Asks the passkey to sign `challenge`; null when it did not (cancelled, unavailable). The
 * main process answers it through its own passkey window, never the page.
 */
export type PasskeyAsserter = (
  challenge: Uint8Array,
) => Promise<PasskeyAssertion | null>;

/** A planning signer that is a pinned passkey (trust mode 2). */
export type PasskeyPlanSigner = PlanSigner & {
  readonly passkey: NonNullable<PlanSigner['passkey']>;
};

/**
 * Builds and signs a gate's next bundle for Moat Desktop. Called in-process by the main process
 * only, never over HTTP (DT-15: the page cannot sign): first prepare() for the dialog, then, once
 * the person confirmed and gave the passphrase, sign() with the preview's digest. The key file
 * is opened here and its secret key zeroed right after signing (SEC-37).
 */
@Injectable()
export class BundleSigningService {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
    private readonly history: HistoryService,
  ) {}

  /**
   * `signer`: the public key of the key file the person chose (its `kid` and `pk`), so the
   * changes are shown against the latest bundle that key signed; null when none is chosen.
   */
  async prepare(
    id: string,
    gate: string,
    signer: PlanSigner | null,
  ): Promise<PrepareBundleResult> {
    const opened = await this.plan(id, gate, signer);
    if (opened.status !== 'planned') return opened;
    const { plan, folder } = opened;
    return {
      status: 'ready',
      preview: {
        project: projectName(folder),
        gate: plan.gate,
        gateId: plan.gateId,
        version: plan.version,
        previousVersion: plan.previousVersion,
        locked: plan.locked,
        changes: plan.changes,
        previous: plan.previous,
        digest: digest(plan),
      },
    };
  }

  async sign(
    id: string,
    gate: string,
    expected: string,
    keyFile: string,
    passphrase: string,
    now: number,
  ): Promise<SignBundleResult> {
    // The key first: the changes the person confirmed were computed against its public key.
    let signer;
    try {
      signer = await openKeyFile(
        parseStrictJson(new TextEncoder().encode(keyFile)),
        passphrase,
      );
    } catch (error) {
      if (
        error instanceof MoatRejection &&
        (error.code === 'keyfile_locked' || error.code === 'keyfile_invalid')
      )
        return { status: 'key_refused', code: error.code };
      if (error instanceof MoatRejection)
        return { status: 'key_refused', code: 'keyfile_invalid' };
      throw error;
    }
    try {
      return await this.signOpened(id, gate, expected, signer, now);
    } finally {
      signer.secretKey.fill(0);
    }
  }

  /**
   * Trust mode 2 (docs/CRYPTO.md §7): the same bundle as `sign`, but the signature is a WebAuthn
   * assertion over `webauthnChallenge(payloadBytes)`. The payload is built first (its time is
   * fixed), the passkey signs its challenge through `assert`, and the envelope is verified here
   * exactly as the gate verifies it — against the pinned passkey, rpId and origins, challenge,
   * UP/UV and signature — before anything is written. A project that changed while the person
   * was at the passkey is not signed (`changed`), and a signature that does not verify writes
   * nothing (fail closed, SEC-46).
   */
  async signWithPasskey(
    id: string,
    gate: string,
    expected: string,
    signer: PasskeyPlanSigner,
    assert: PasskeyAsserter,
    now: number,
  ): Promise<SignBundleResult> {
    const opened = await this.plan(id, gate, signer);
    if (opened.status === 'refused')
      return { status: 'refused', code: opened.code };
    if (opened.status !== 'planned') return opened;
    const { plan, folder } = opened;
    if (digest(plan) !== expected) return { status: 'changed' };

    const payloadBytes = bundlePayloadBytes(
      buildBundlePayload({
        config: plan.source,
        gate: plan.gate,
        gateId: plan.gateId,
        secrets: plan.secrets,
        version: plan.version,
        issuedAt: now,
      }),
    );
    const assertion = await assert(await webauthnChallenge(payloadBytes));
    if (assertion === null)
      return { status: 'passkey_refused', code: 'cancelled' };
    const envelope = assembleEnvelope(payloadBytes, [
      webauthnSignature({ kid: signer.kid, ...assertion }),
    ]);
    try {
      const verified = await verifyBundle(new TextEncoder().encode(envelope), {
        gateId: plan.gateId,
        signers: [pinnedSignerOf(signer)],
        threshold: 1,
        currentVersion: plan.version - 1,
        now,
        expiryEnabled: false,
      });
      if (verified.payload.version !== plan.version)
        return { status: 'passkey_refused', code: 'assertion_invalid' };
    } catch (error) {
      if (error instanceof MoatRejection)
        return { status: 'passkey_refused', code: 'assertion_invalid' };
      throw error;
    }

    // The person may have been at the passkey for a while: sign nothing but what they confirmed.
    const again = await this.plan(id, gate, signer);
    if (again.status !== 'planned' || digest(again.plan) !== expected)
      return { status: 'changed' };
    try {
      this.files.writeBundle(folder, plan.gate, plan.version, envelope);
    } catch (error) {
      if (error instanceof BundleExistsError) return { status: 'changed' };
      return { status: 'not_writable' };
    }
    await this.history.record(id, {
      kind: 'bundle_signed',
      details: {
        gate: plan.gate,
        version: plan.version,
        sha256: createHash('sha256').update(envelope, 'utf8').digest('hex'),
        kid: signer.kid,
      },
    });
    return { status: 'signed', version: plan.version, kid: signer.kid };
  }

  private async signOpened(
    id: string,
    gate: string,
    expected: string,
    signer: Awaited<ReturnType<typeof openKeyFile>>,
    now: number,
  ): Promise<SignBundleResult> {
    const opened = await this.plan(id, gate, signer);
    if (opened.status === 'refused')
      return { status: 'refused', code: opened.code };
    if (opened.status !== 'planned') return opened;
    const { plan, folder } = opened;
    if (digest(plan) !== expected) return { status: 'changed' };

    const envelope = await buildBundle(
      {
        config: plan.source,
        gate: plan.gate,
        gateId: plan.gateId,
        secrets: plan.secrets,
        version: plan.version,
        issuedAt: now,
      },
      [signer],
    );
    try {
      this.files.writeBundle(folder, plan.gate, plan.version, envelope);
    } catch (error) {
      // Another window or the CLI built this version meanwhile: show the new state.
      if (error instanceof BundleExistsError) return { status: 'changed' };
      return { status: 'not_writable' };
    }
    await this.history.record(id, {
      kind: 'bundle_signed',
      details: {
        gate: plan.gate,
        version: plan.version,
        sha256: createHash('sha256').update(envelope, 'utf8').digest('hex'),
        kid: signer.kid,
      },
    });
    return { status: 'signed', version: plan.version, kid: signer.kid };
  }

  private async plan(
    id: string,
    gate: string,
    signer: PlanSigner | null,
  ): Promise<
    | { status: 'planned'; plan: BundlePlan; folder: string }
    | { status: 'not_found' }
    | {
        status: 'refused';
        code: BundlePlanErrorCode;
        secrets: readonly string[];
      }
  > {
    if (!PROJECT_ID.test(id)) return { status: 'not_found' };
    const entry = this.registry.get(id);
    const storage = entry === null ? null : this.files.open(entry.folder);
    if (entry === null || storage === null) return { status: 'not_found' };
    try {
      return {
        status: 'planned',
        plan: await planBundle(storage, gate, signer),
        folder: entry.folder,
      };
    } catch (error) {
      if (error instanceof BundlePlanError)
        return { status: 'refused', code: error.code, secrets: error.secrets };
      throw error;
    }
  }
}

/**
 * SHA-256 over the canonical JSON of everything that goes into the bundle but the time, and of
 * what the dialog showed about it (the changes, against which bundle): confirming one preview
 * never signs another.
 */
function digest(plan: BundlePlan): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        gateId: plan.gateId,
        version: plan.version,
        config: plan.config,
        secrets: plan.secrets,
        changes: plan.changes,
        previous: plan.previous,
      } as unknown as JsonValue),
    )
    .digest('hex');
}
