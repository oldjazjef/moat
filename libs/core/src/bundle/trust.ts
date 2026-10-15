import { fromBase64Url, toBase64Url } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import { keyId } from '../crypto/kid';
import {
  isPasskeyOrigin,
  isPasskeyPoint,
  isRpId,
  MAX_ORIGINS,
  PASSKEY_POINT_LENGTH,
  WEBAUTHN_ALG,
} from '../crypto/webauthn';
import { MoatRejection, reject } from '../errors';
import {
  hasExactKeys,
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';
import type { PinnedSigner } from './bundle';

/** The pinned trust anchors of a gate (`trust.json`, docs/CRYPTO.md §8). */
export interface TrustFile {
  readonly gateId: string;
  /** 0 Bequem, 1 Signiert, 2 Passkey. The mode says which algorithm its signers use. */
  readonly mode: 0 | 1 | 2;
  readonly threshold: number;
  readonly signers: readonly PinnedSigner[];
}

export const MAX_TRUST_SIGNERS = 16;

/**
 * Parses and checks a trust file exactly as a gate does (docs/CRYPTO.md §7.1, §8): modes 0 and 1
 * pin only Ed25519 signers, mode 2 only `webauthn-es256` signers with `rpId` and `origins`; no
 * mixing, no unknown key, a `kid` that is not the key's own, duplicates, a threshold outside
 * 1..signers. Anything wrong → `trust_invalid`.
 */
export async function parseTrust(
  bytes: Uint8Array | string,
  gateId: string,
): Promise<TrustFile> {
  try {
    return await parse(typeof bytes === 'string' ? utf8(bytes) : bytes, gateId);
  } catch (error) {
    if (error instanceof MoatRejection && error.code === 'trust_invalid') {
      throw error;
    }
    return reject('trust_invalid');
  }
}

async function parse(raw: Uint8Array, gateId: string): Promise<TrustFile> {
  const value = parseStrictJson(raw);
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, [
      'v',
      'gateId',
      'mode',
      'threshold',
      'signers',
      'cloud',
    ]) ||
    value['v'] !== 1 ||
    value['gateId'] !== gateId ||
    value['cloud'] !== null
  ) {
    return reject('trust_invalid');
  }
  const mode = value['mode'];
  const entries = value['signers'];
  const threshold = value['threshold'];
  if (
    (mode !== 0 && mode !== 1 && mode !== 2) ||
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > MAX_TRUST_SIGNERS ||
    typeof threshold !== 'number' ||
    threshold < 1 ||
    threshold > entries.length
  ) {
    return reject('trust_invalid');
  }
  const signers: PinnedSigner[] = [];
  for (const entry of entries) {
    const signer = await (mode === 2
      ? passkeySigner(entry)
      : ed25519Signer(entry));
    if (signers.some((known) => known.kid === signer.kid)) {
      return reject('trust_invalid');
    }
    signers.push(signer);
  }
  return { gateId, mode, threshold, signers };
}

async function ed25519Signer(entry: JsonValue): Promise<PinnedSigner> {
  if (
    !isJsonObject(entry) ||
    !hasExactKeys(entry, ['kid', 'alg', 'pk']) ||
    entry['alg'] !== 'ed25519' ||
    typeof entry['pk'] !== 'string'
  ) {
    return reject('trust_invalid');
  }
  const publicKey = fromBase64Url(entry['pk']);
  if (
    publicKey.length !== 32 ||
    (await keyId('ed25519', publicKey)) !== entry['kid']
  ) {
    return reject('trust_invalid');
  }
  return { kid: entry['kid'], alg: 'ed25519', publicKey };
}

async function passkeySigner(entry: JsonValue): Promise<PinnedSigner> {
  if (
    !isJsonObject(entry) ||
    !hasExactKeys(entry, ['kid', 'alg', 'pk', 'rpId', 'origins']) ||
    entry['alg'] !== WEBAUTHN_ALG ||
    typeof entry['pk'] !== 'string'
  ) {
    return reject('trust_invalid');
  }
  const rpId = entry['rpId'];
  const origins = entry['origins'];
  if (
    !isRpId(rpId) ||
    !Array.isArray(origins) ||
    origins.length < 1 ||
    origins.length > MAX_ORIGINS ||
    !origins.every(isPasskeyOrigin) ||
    new Set(origins).size !== origins.length
  ) {
    return reject('trust_invalid');
  }
  const publicKey = fromBase64Url(entry['pk']);
  if (
    publicKey.length !== PASSKEY_POINT_LENGTH ||
    !isPasskeyPoint(publicKey) ||
    (await keyId(WEBAUTHN_ALG, publicKey)) !== entry['kid']
  ) {
    return reject('trust_invalid');
  }
  return { kid: entry['kid'], alg: WEBAUTHN_ALG, publicKey, rpId, origins };
}

/** The trust file text for `trust.json` (docs/CRYPTO.md §8); the gate's own CLI writes the same. */
export function encodeTrust(trust: TrustFile): string {
  const signers = trust.signers.map((signer) =>
    signer.alg === 'ed25519'
      ? { kid: signer.kid, alg: signer.alg, pk: toBase64Url(signer.publicKey) }
      : {
          kid: signer.kid,
          alg: signer.alg,
          pk: toBase64Url(signer.publicKey),
          rpId: signer.rpId,
          origins: [...signer.origins],
        },
  );
  return `${JSON.stringify(
    {
      v: 1,
      gateId: trust.gateId,
      mode: trust.mode,
      threshold: trust.threshold,
      signers,
      cloud: null,
    },
    null,
    2,
  )}\n`;
}
