import { fingerprint, keyId } from '../crypto/kid';
import { fromBase64UrlLength } from '../encoding/base64url';
import { MoatRejection } from '../errors';
import { GATE_ID, NAME_PATTERN } from './project';

/**
 * Pinning a gate in a project (`gates/<name>.json`, SEC-32): its id and the public half of its
 * box key, both as `php moat-gate.php install` printed them. Before the file is written the
 * person compares the fingerprint with what the gate printed; `planGate` gives that fingerprint
 * and the exact file, so what is written is what was compared.
 */
export interface GatePlan {
  readonly name: string;
  readonly gateId: string;
  /** The box key as written (base64url, 32 bytes). */
  readonly boxKey: string;
  readonly boxKeyId: string;
  /** `MOAT-…`: what the gate printed as "Box key" at install. */
  readonly boxKeyFingerprint: string;
  /** `gates/<name>.json` */
  readonly path: string;
  readonly text: string;
}

export type GatePlanErrorCode =
  'name_invalid' | 'gate_id_invalid' | 'box_key_invalid';

export class GatePlanError extends Error {
  override readonly name = 'GatePlanError';
  constructor(readonly code: GatePlanErrorCode) {
    super(code);
  }
}

/** The file of a gate, the same the CLI's `moat gate add` writes. */
export async function planGate(input: {
  readonly name: string;
  readonly gateId: string;
  readonly boxKey: string;
}): Promise<GatePlan> {
  if (!NAME_PATTERN.test(input.name)) throw new GatePlanError('name_invalid');
  if (!GATE_ID.test(input.gateId)) throw new GatePlanError('gate_id_invalid');
  let boxPublicKey: Uint8Array;
  try {
    boxPublicKey = fromBase64UrlLength(input.boxKey, 32);
  } catch (error) {
    if (error instanceof MoatRejection)
      throw new GatePlanError('box_key_invalid');
    throw error;
  }
  const file = {
    moat: 'gate',
    v: 1,
    gateId: input.gateId,
    boxKey: input.boxKey,
  };
  return {
    name: input.name,
    gateId: input.gateId,
    boxKey: input.boxKey,
    boxKeyId: await keyId('x25519', boxPublicKey),
    boxKeyFingerprint: await fingerprint('x25519', boxPublicKey),
    path: `gates/${input.name}.json`,
    text: `${JSON.stringify(file, null, 2)}\n`,
  };
}
