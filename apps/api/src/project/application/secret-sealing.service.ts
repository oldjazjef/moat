import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  isSecretValue,
  planSeal,
  SealPlanError,
  sealSecret,
  toBase64Url,
  type SealPlan,
  type SealPlanErrorCode,
} from '@moat/core';
import { ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';
import { projectName } from './project-name';

/** What the seal dialog shows before it asks for the value: never a value, never ciphertext. */
export interface SealPreview {
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  readonly boxKeyFingerprint: string;
  readonly name: string;
  readonly currentVersion: number | null;
  readonly nextVersion: number;
  readonly usedBy: SealPlan['usedBy'];
  /** Binds the value to exactly this gate key and version: seal() refuses when they changed. */
  readonly digest: string;
}

export type PrepareSealResult =
  | { readonly status: 'ready'; readonly preview: SealPreview }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: SealPlanErrorCode };

export type SealResult =
  | { readonly status: 'sealed'; readonly secretVersion: number }
  | { readonly status: 'not_found' }
  /** The gate file or the sealed secret changed after the dialog opened: nothing written. */
  | { readonly status: 'changed' }
  | { readonly status: 'refused'; readonly code: SealPlanErrorCode }
  /** Empty, too long, a line break or NUL, or not UTF-8. */
  | { readonly status: 'value_invalid' }
  | { readonly status: 'not_writable' };

/**
 * Seals a secret for one gate in Moat Desktop. Called in-process by the main process only, never
 * over HTTP: the value is typed in the main process's own window, not in the page, and only the
 * ciphertext is written (SEC-31, SEC-33). The plaintext buffer is zeroed here.
 */
@Injectable()
export class SecretSealingService {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async prepare(
    id: string,
    gate: string,
    name: string,
  ): Promise<PrepareSealResult> {
    const opened = await this.plan(id, gate, name);
    if (opened.status !== 'planned') return opened;
    const { plan, folder } = opened;
    return {
      status: 'ready',
      preview: {
        project: projectName(folder),
        gate: plan.gate,
        gateId: plan.gateId,
        boxKeyFingerprint: plan.boxKeyFingerprint,
        name: plan.name,
        currentVersion: plan.currentVersion,
        nextVersion: plan.nextVersion,
        usedBy: plan.usedBy,
        digest: digest(plan),
      },
    };
  }

  /** `plaintext` is zeroed before this returns, whatever the outcome. */
  async seal(
    id: string,
    gate: string,
    name: string,
    expected: string,
    plaintext: Uint8Array,
  ): Promise<SealResult> {
    try {
      if (!isSecretValue(plaintext)) return { status: 'value_invalid' };
      const opened = await this.plan(id, gate, name);
      if (opened.status !== 'planned') return opened;
      const { plan, folder } = opened;
      if (digest(plan) !== expected) return { status: 'changed' };
      const sealed = await sealSecret(plaintext, plan.boxPublicKey, {
        gateId: plan.gateId,
        secretName: plan.name,
        secretVersion: plan.nextVersion,
      });
      try {
        this.files.writeSecret(
          folder,
          plan.gate,
          plan.name,
          `${JSON.stringify(sealed, null, 2)}\n`,
        );
      } catch {
        return { status: 'not_writable' };
      }
      return { status: 'sealed', secretVersion: plan.nextVersion };
    } finally {
      plaintext.fill(0);
    }
  }

  private async plan(
    id: string,
    gate: string,
    name: string,
  ): Promise<
    | { status: 'planned'; plan: SealPlan; folder: string }
    | { status: 'not_found' }
    | { status: 'refused'; code: SealPlanErrorCode }
  > {
    if (!PROJECT_ID.test(id)) return { status: 'not_found' };
    const entry = this.registry.get(id);
    const storage = entry === null ? null : this.files.open(entry.folder);
    if (entry === null || storage === null) return { status: 'not_found' };
    try {
      return {
        status: 'planned',
        plan: await planSeal(storage, gate, name),
        folder: entry.folder,
      };
    } catch (error) {
      if (error instanceof SealPlanError)
        return { status: 'refused', code: error.code };
      throw error;
    }
  }
}

/**
 * SHA-256 over what the dialog shows: what the value is bound to (gate id, box key, name, new
 * version) and the upstreams that send it, so a change to either asks again (§1.5).
 */
function digest(plan: SealPlan): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        plan.gateId,
        toBase64Url(plan.boxPublicKey),
        plan.name,
        plan.nextVersion,
        plan.usedBy.map(({ upstream, origin }) => [upstream, origin]),
      ]),
    )
    .digest('hex');
}
