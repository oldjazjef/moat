import { verifyBundle } from '../bundle/bundle';
import { validateCompiledConfig } from '../config/compiled';
import { MoatRejection } from '../errors';
import { suggestPolicy, type Policy } from '../policy/policy';
import { BundlePlanError, readGateId, type PlanSigner } from './bundle-plan';
import { latestBundle, NAME_PATTERN } from './project';
import type { StoragePort } from './storage-port';

/**
 * What goes onto the server for a gate's latest bundle (DT-05): the bundle file exactly as it was
 * signed, and the policy suggested for exactly that bundle's config. Only a bundle that verifies
 * against the person's own key, for this gate, counts (as the gate would check it, CRYPTO.md
 * §4.3): a bundle file planted in the project folder must not shape the policy the person
 * installs on the server (T-66). Pure: reads through the StoragePort, writes nothing.
 */
export interface DeployPlan {
  readonly gate: string;
  readonly gateId: string;
  readonly version: number;
  /** The bundle locks the gate (`enabled: false`). */
  readonly locked: boolean;
  /** `bundles/<gate>/<version>.json`, unchanged: the gate verifies these bytes. */
  readonly bundle: string;
  /** suggestPolicy of the bundle's config: what `php moat-gate.php policy` installs. */
  readonly policy: Policy;
}

export type DeployPlanErrorCode =
  'gate_unknown' | 'bundle_missing' | 'bundle_unverified';

export class DeployPlanError extends Error {
  override readonly name = 'DeployPlanError';
  constructor(readonly code: DeployPlanErrorCode) {
    super(code);
  }
}

export async function planDeploy(
  storage: StoragePort,
  gate: string,
  signer: PlanSigner,
): Promise<DeployPlan> {
  if (!NAME_PATTERN.test(gate)) throw new DeployPlanError('gate_unknown');
  let gateId: string;
  try {
    gateId = readGateId(storage, gate);
  } catch (error) {
    if (error instanceof BundlePlanError)
      throw new DeployPlanError('gate_unknown');
    throw error;
  }
  const version = latestBundle(storage, gate);
  const text =
    version === 0 ? null : storage.read(`bundles/${gate}/${version}.json`);
  if (text === null) throw new DeployPlanError('bundle_missing');
  try {
    const { payload } = await verifyBundle(new TextEncoder().encode(text), {
      gateId,
      signers: [
        { kid: signer.kid, alg: 'ed25519', publicKey: signer.publicKey },
      ],
      threshold: 1,
      currentVersion: version - 1,
      now: 0,
      expiryEnabled: false,
    });
    if (payload.version !== version)
      throw new DeployPlanError('bundle_unverified');
    const config = validateCompiledConfig(
      payload.config,
      Object.keys(payload.secrets),
    );
    return {
      gate,
      gateId,
      version,
      locked: config.enabled === false,
      bundle: text,
      policy: suggestPolicy(config),
    };
  } catch (error) {
    if (error instanceof MoatRejection)
      throw new DeployPlanError('bundle_unverified');
    throw error;
  }
}
