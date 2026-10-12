import {
  fromBase64UrlLength,
  fromBase64Url,
  toBase64Url,
} from '../encoding/base64url';
import { concatBytes, utf8 } from '../encoding/utf8';
import { reject } from '../errors';
import { hasExactKeys, isJsonObject } from '../json/strict-json';
import { sodium, type Sodium } from '../crypto/sodium';

/** docs/CRYPTO.md §5. */
export const SEALED_SECRET_ALG = 'x25519-blake2b-xchacha20poly1305';
const DOMAIN = 'moat:secret:v1';

export interface SealedSecret {
  readonly v: 1;
  readonly alg: typeof SEALED_SECRET_ALG;
  readonly secretVersion: number;
  readonly epk: string;
  readonly nonce: string;
  readonly ct: string;
}

export interface SecretBinding {
  readonly gateId: string;
  readonly secretName: string;
  readonly secretVersion: number;
}

/** Only for the conformance vectors: fixed ephemeral key and nonce. Not exported from index. */
export interface SealRandomness {
  readonly ephemeralSecretKey: Uint8Array;
  readonly nonce: Uint8Array;
}

function associatedData(binding: SecretBinding): Uint8Array {
  return utf8(
    `${DOMAIN}|${binding.gateId}|${binding.secretName}|${binding.secretVersion}`,
  );
}

function deriveKey(
  na: Sodium,
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  gatePublicKey: Uint8Array,
): Uint8Array {
  if (sharedSecret.every((byte) => byte === 0)) reject('secret_invalid');
  return na.crypto_generichash(
    32,
    concatBytes(utf8(DOMAIN), ephemeralPublicKey, gatePublicKey),
    sharedSecret,
  );
}

/** Seals a secret for one gate. Runs on the client (Desktop, CLI, browser), never in the Cloud. */
export async function sealSecret(
  plaintext: Uint8Array,
  gatePublicKey: Uint8Array,
  binding: SecretBinding,
  randomness?: SealRandomness,
): Promise<SealedSecret> {
  const na = await sodium();
  const ephemeralSecretKey =
    randomness?.ephemeralSecretKey ??
    na.randombytes_buf(na.crypto_box_SECRETKEYBYTES);
  const nonce =
    randomness?.nonce ??
    na.randombytes_buf(na.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ephemeralPublicKey = na.crypto_scalarmult_base(ephemeralSecretKey);
  const shared = na.crypto_scalarmult(ephemeralSecretKey, gatePublicKey);
  const key = deriveKey(na, shared, ephemeralPublicKey, gatePublicKey);
  const ct = na.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData(binding),
    null,
    nonce,
    key,
  );
  if (randomness === undefined) na.memzero(ephemeralSecretKey);
  na.memzero(shared);
  na.memzero(key);
  return {
    v: 1,
    alg: SEALED_SECRET_ALG,
    secretVersion: binding.secretVersion,
    epk: toBase64Url(ephemeralPublicKey),
    nonce: toBase64Url(nonce),
    ct: toBase64Url(ct),
  };
}

/**
 * Opens a sealed secret with the gate's own key. Gate id and name come from the gate (its own id,
 * the name the secret is stored under) — never from the sealed object — so a ciphertext copied to
 * another gate or name fails authentication (SEC-33). Any failure → `secret_invalid`.
 */
export async function openSecret(
  sealed: unknown,
  gateSecretKey: Uint8Array,
  gateId: string,
  secretName: string,
): Promise<Uint8Array> {
  if (
    !isJsonObject(sealed) ||
    !hasExactKeys(sealed, [
      'v',
      'alg',
      'secretVersion',
      'epk',
      'nonce',
      'ct',
    ]) ||
    sealed['v'] !== 1 ||
    sealed['alg'] !== SEALED_SECRET_ALG ||
    typeof sealed['secretVersion'] !== 'number' ||
    !Number.isSafeInteger(sealed['secretVersion']) ||
    sealed['secretVersion'] < 1 ||
    typeof sealed['ct'] !== 'string'
  ) {
    reject('secret_invalid');
  }
  const na = await sodium();
  try {
    const epk = fromBase64UrlLength(
      sealed['epk'],
      na.crypto_box_PUBLICKEYBYTES,
    );
    const nonce = fromBase64UrlLength(
      sealed['nonce'],
      na.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    const ct = fromBase64Url(sealed['ct']);
    const gatePublicKey = na.crypto_scalarmult_base(gateSecretKey);
    const shared = na.crypto_scalarmult(gateSecretKey, epk);
    const key = deriveKey(na, shared, epk, gatePublicKey);
    na.memzero(shared);
    try {
      return na.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ct,
        associatedData({
          gateId,
          secretName,
          secretVersion: sealed['secretVersion'],
        }),
        nonce,
        key,
      );
    } finally {
      na.memzero(key);
    }
  } catch {
    reject('secret_invalid');
  }
}
