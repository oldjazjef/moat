import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  buildBundle,
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
  | { readonly status: 'not_writable' };

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
