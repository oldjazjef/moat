import {
  fromBase64Url,
  keyId,
  fingerprint,
  type SealedSecret,
} from '@moat/core';
import { exists, list, readJson, UsageError, type Context } from './context';

/**
 * The project folder (DT-14): plain files that live well in Git.
 *
 *   moat.yaml                         the config (no secrets)
 *   gates/<gate>.json                 a gate's public identity, pinned after comparing fingerprints
 *   secrets/<gate>/<name>.json        secrets sealed for that gate (ciphertext only, SEC-31)
 *   bundles/<gate>/<version>.json     signed bundles, ready to deploy
 */
export const CONFIG_FILE = 'moat.yaml';
export const NAME = /^[a-z][a-z0-9-]{0,62}$/;

export interface GateFile {
  readonly moat: 'gate';
  readonly v: 1;
  readonly gateId: string;
  /** The gate's X25519 box public key, base64url. */
  readonly boxKey: string;
}

export function checkName(kind: string, value: string | undefined): string {
  if (value === undefined || !NAME.test(value)) {
    throw new UsageError(`${kind} must match ${NAME.source}`);
  }
  return value;
}

export function gatePath(gate: string): string {
  return `gates/${checkName('gate name', gate)}.json`;
}

export function readGate(
  context: Context,
  gate: string,
): GateFile & { boxPublicKey: Uint8Array } {
  if (!exists(context, gatePath(gate)))
    throw new UsageError(
      `no gate "${gate}": ${gatePath(gate)} is missing (moat gate add)`,
    );
  const value = readJson(context, gatePath(gate)) as Partial<GateFile>;
  if (
    value.moat !== 'gate' ||
    value.v !== 1 ||
    typeof value.gateId !== 'string' ||
    typeof value.boxKey !== 'string'
  ) {
    throw new UsageError(`${gatePath(gate)} is not a gate file`);
  }
  const boxPublicKey = fromBase64Url(value.boxKey);
  if (boxPublicKey.length !== 32)
    throw new UsageError(`${gatePath(gate)}: boxKey must be 32 bytes`);
  return {
    moat: 'gate',
    v: 1,
    gateId: value.gateId,
    boxKey: value.boxKey,
    boxPublicKey,
  };
}

export async function boxFingerprint(
  boxPublicKey: Uint8Array,
): Promise<{ kid: string; fingerprint: string }> {
  return {
    kid: await keyId('x25519', boxPublicKey),
    fingerprint: await fingerprint('x25519', boxPublicKey),
  };
}

export function secretPath(gate: string, name: string): string {
  return `secrets/${checkName('gate name', gate)}/${checkName('secret name', name)}.json`;
}

export function readSealedSecrets(
  context: Context,
  gate: string,
): Record<string, SealedSecret> {
  const secrets: Record<string, SealedSecret> = {};
  for (const file of list(context, `secrets/${checkName('gate name', gate)}`)) {
    const name = file.replace(/\.json$/, '');
    if (!file.endsWith('.json') || !NAME.test(name)) continue;
    secrets[name] = readJson(context, secretPath(gate, name)) as SealedSecret;
  }
  return secrets;
}

export function bundleDir(gate: string): string {
  return `bundles/${checkName('gate name', gate)}`;
}

/** The highest version already built for this gate, 0 when none. */
export function lastVersion(context: Context, gate: string): number {
  return list(context, bundleDir(gate))
    .map((file) => /^([1-9][0-9]*)\.json$/.exec(file)?.[1])
    .filter((version): version is string => version !== undefined)
    .reduce((max, version) => Math.max(max, Number(version)), 0);
}
