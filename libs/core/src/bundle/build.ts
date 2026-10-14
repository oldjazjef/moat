import { usedSecrets } from '../config/secrets';
import { compileConfig } from '../config/compile';
import type { MoatConfig } from '../config/schema';
import type { JsonValue } from '../json/strict-json';
import { checkPolicy, type Policy } from '../policy/policy';
import type { SealedSecret } from '../secrets/seal';
import { signBundle, type BundlePayload, type Ed25519Signer } from './bundle';

export interface BuildBundleInput {
  readonly config: MoatConfig;
  /** The gate's name in the project (`gates/<gate>.json`): decides whether the bundle locks it. */
  readonly gate: string;
  readonly gateId: string;
  /** Sealed for this gate (sealSecret), by the name the config references. */
  readonly secrets: Readonly<Record<string, SealedSecret>>;
  readonly version: number;
  /** Seconds since the epoch — passed in, the core has no clock. */
  readonly issuedAt: number;
  readonly expiresAt?: number | null;
  /** When known (Desktop, CLI with the gate's policy): fail here instead of on the gate. */
  readonly policy?: Policy;
}

/**
 * Compiles the config for this gate (locked when the gate or its environment is), checks it as
 * the gate will (schema, references, optional local policy) and signs the bundle. Only secrets the config references go in — nothing else leaves the
 * project folder.
 */
export async function buildBundle(
  input: BuildBundleInput,
  signers: readonly Ed25519Signer[],
): Promise<string> {
  const referenced = new Set(usedSecrets(input.config));
  const secrets: Record<string, JsonValue> = {};
  for (const name of [...referenced].sort()) {
    const sealed = input.secrets[name];
    if (sealed !== undefined) secrets[name] = sealed as unknown as JsonValue;
  }
  const config = compileConfig(input.config, Object.keys(secrets), input.gate);
  if (input.policy !== undefined) checkPolicy(config, input.policy);
  const payload: BundlePayload = {
    type: 'moat.bundle',
    v: 1,
    gateId: input.gateId,
    version: input.version,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt ?? null,
    config: config as unknown as BundlePayload['config'],
    secrets,
  };
  return signBundle(payload, signers);
}
