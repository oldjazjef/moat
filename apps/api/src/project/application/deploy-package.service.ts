import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DeployPlanError,
  planDeploy,
  type DeployPlanErrorCode,
  type PlanSigner,
} from '@moat/core';
import { ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';
import { projectName } from './project-name';

/**
 * What a deploy package of a gate holds (DT-05): the latest bundle signed with the person's key,
 * byte for byte, and the policy for exactly that bundle. Ciphertext only: the bundle carries the
 * sealed secrets, never a value (SEC-31).
 */
export interface DeployPackage {
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  readonly version: number;
  readonly locked: boolean;
  /** `bundles/<gate>/<version>.json`, unchanged. */
  readonly bundle: string;
  /** SHA-256 (hex) of `bundle`, to compare after the upload. */
  readonly bundleSha256: string;
  /** The suggested policy as `moat policy suggest` prints it. */
  readonly policy: string;
}

export type PrepareDeployResult =
  | { readonly status: 'ready'; readonly package: DeployPackage }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: DeployPlanErrorCode };

/**
 * Moat Desktop's deploy package. Called in-process by the main process only, never over HTTP:
 * where the package goes is chosen in the main process's own dialog (DT-08), and the page learns
 * only the outcome.
 */
@Injectable()
export class DeployPackageService {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  /** `signer`: the public half of the person's key; only a bundle it signed is packaged. */
  async prepare(
    id: string,
    gate: string,
    signer: PlanSigner,
  ): Promise<PrepareDeployResult> {
    if (!PROJECT_ID.test(id)) return { status: 'not_found' };
    const entry = this.registry.get(id);
    const storage = entry === null ? null : this.files.open(entry.folder);
    if (entry === null || storage === null) return { status: 'not_found' };
    try {
      const plan = await planDeploy(storage, gate, signer);
      return {
        status: 'ready',
        package: {
          project: projectName(entry.folder),
          gate: plan.gate,
          gateId: plan.gateId,
          version: plan.version,
          locked: plan.locked,
          bundle: plan.bundle,
          bundleSha256: createHash('sha256').update(plan.bundle).digest('hex'),
          policy: `${JSON.stringify(plan.policy, null, 2)}\n`,
        },
      };
    } catch (error) {
      if (error instanceof DeployPlanError)
        return { status: 'refused', code: error.code };
      throw error;
    }
  }
}
