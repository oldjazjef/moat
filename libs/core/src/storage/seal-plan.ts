import { ConfigError, loadMoatYaml } from '../config/yaml';
import type { MoatConfig } from '../config/schema';
import { fingerprint } from '../crypto/kid';
import { MoatRejection } from '../errors';
import {
  CONFIG_FILE,
  decode,
  GATE_ID,
  isRecord,
  NAME_PATTERN,
  parseJson,
} from './project';
import type { StoragePort } from './storage-port';

/**
 * What sealing a secret for a gate would do, before the value is asked for: which gate (id and the
 * fingerprint of its box key, to compare with what the gate printed, SEC-32), which upstreams send
 * the secret, and its next version. Pure: reads the project only, sees no secret value.
 */
export interface SealPlan {
  readonly gate: string;
  readonly gateId: string;
  /** The gate's X25519 box public key: the only key the value is sealed to. */
  readonly boxPublicKey: Uint8Array;
  readonly boxKeyFingerprint: string;
  readonly name: string;
  /** Null when it is not sealed for this gate yet. */
  readonly currentVersion: number | null;
  /** currentVersion + 1, or 1. */
  readonly nextVersion: number;
  /** The upstreams of moat.yaml that send it (name and origin), sorted. */
  readonly usedBy: readonly {
    readonly upstream: string;
    readonly origin: string;
  }[];
}

export type SealPlanErrorCode =
  | 'config_missing'
  | 'config_invalid'
  | 'gate_unknown'
  /** The name is no secret moat.yaml uses, and none is sealed under it for this gate. */
  | 'secret_unknown'
  /** A sealed file exists under the name but is not one: its version would start again at 1. */
  | 'secret_unreadable';

export class SealPlanError extends Error {
  override readonly name = 'SealPlanError';

  constructor(readonly code: SealPlanErrorCode) {
    super(code);
  }
}

/** The longest value sealed (an API key or token, never a file). */
export const MAX_SECRET_BYTES = 8 * 1024;

/**
 * A secret value as the gate sends it: not empty, at most MAX_SECRET_BYTES of UTF-8, no line
 * break or NUL (it goes into a header or a query parameter), as `moat secret seal` checks.
 */
export function isSecretValue(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) return false;
  if (bytes.some((byte) => byte === 0x0a || byte === 0x0d || byte === 0x00))
    return false;
  return isUtf8(bytes);
}

/**
 * Well-formed UTF-8 (RFC 3629: shortest form, no surrogates, at most U+10FFFF), checked on the
 * bytes: decoding to a string would leave a copy of the value that cannot be zeroed.
 */
function isUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i] ?? 0;
    if (lead < 0x80) {
      i += 1;
      continue;
    }
    let length: number;
    let low = 0x80;
    let high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) length = 2;
    else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      if (lead === 0xe0) low = 0xa0;
      if (lead === 0xed) high = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      if (lead === 0xf0) low = 0x90;
      if (lead === 0xf4) high = 0x8f;
    } else return false;
    if (i + length > bytes.length) return false;
    for (let k = 1; k < length; k++) {
      const next = bytes[i + k] ?? 0;
      const min = k === 1 ? low : 0x80;
      const max = k === 1 ? high : 0xbf;
      if (next < min || next > max) return false;
    }
    i += length;
  }
  return true;
}

export async function planSeal(
  storage: StoragePort,
  gate: string,
  name: string,
): Promise<SealPlan> {
  if (!NAME_PATTERN.test(gate)) throw new SealPlanError('gate_unknown');
  if (!NAME_PATTERN.test(name)) throw new SealPlanError('secret_unknown');
  const file = parseJson(storage.read(`gates/${gate}.json`));
  const boxPublicKey =
    isRecord(file) && typeof file['boxKey'] === 'string'
      ? decode(file['boxKey'])
      : null;
  if (
    !isRecord(file) ||
    file['moat'] !== 'gate' ||
    file['v'] !== 1 ||
    typeof file['gateId'] !== 'string' ||
    !GATE_ID.test(file['gateId']) ||
    boxPublicKey?.length !== 32
  )
    throw new SealPlanError('gate_unknown');

  const config = readConfig(storage);
  const usedBy = Object.entries(config.upstreams)
    .filter(([, upstream]) => upstream.auth?.secret === name)
    .map(([upstream, { origin }]) => ({ upstream, origin }))
    .sort((a, b) => (a.upstream < b.upstream ? -1 : 1));
  const sealedText = storage.read(`secrets/${gate}/${name}.json`);
  const sealed = parseJson(sealedText);
  const version = isRecord(sealed) ? sealed['secretVersion'] : undefined;
  const currentVersion =
    typeof version === 'number' && Number.isSafeInteger(version) && version > 0
      ? version
      : null;
  if (sealedText !== null && currentVersion === null)
    throw new SealPlanError('secret_unreadable');
  if (usedBy.length === 0 && currentVersion === null)
    throw new SealPlanError('secret_unknown');
  return {
    gate,
    gateId: file['gateId'],
    boxPublicKey,
    boxKeyFingerprint: await fingerprint('x25519', boxPublicKey),
    name,
    currentVersion,
    nextVersion: (currentVersion ?? 0) + 1,
    usedBy,
  };
}

function readConfig(storage: StoragePort): MoatConfig {
  const text = storage.read(CONFIG_FILE);
  if (text === null) throw new SealPlanError('config_missing');
  try {
    return loadMoatYaml(text);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MoatRejection)
      throw new SealPlanError('config_invalid');
    throw error;
  }
}
