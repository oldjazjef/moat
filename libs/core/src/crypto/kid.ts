import { toBase32 } from '../encoding/base32';
import { toBase64Url } from '../encoding/base64url';
import { concatBytes, utf8 } from '../encoding/utf8';
import { sodium } from './sodium';

export const KEY_ALGORITHMS = ['ed25519', 'x25519', 'webauthn-es256'] as const;
export type KeyAlgorithm = (typeof KEY_ALGORITHMS)[number];

/** 16-byte key id: BLAKE2b-128("moat:kid:v1|" ‖ alg ‖ "|" ‖ publicKey), docs/CRYPTO.md §3. */
export async function keyIdBytes(
  alg: KeyAlgorithm,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  const na = await sodium();
  return na.crypto_generichash(
    16,
    concatBytes(utf8(`moat:kid:v1|${alg}|`), publicKey),
    null,
  );
}

export async function keyId(
  alg: KeyAlgorithm,
  publicKey: Uint8Array,
): Promise<string> {
  return toBase64Url(await keyIdBytes(alg, publicKey));
}

/** Human fingerprint for SEC-32: `MOAT-` + base32 of the key id in groups of four. */
export async function fingerprint(
  alg: KeyAlgorithm,
  publicKey: Uint8Array,
): Promise<string> {
  const groups =
    toBase32(await keyIdBytes(alg, publicKey)).match(/.{1,4}/g) ?? [];
  return ['MOAT', ...groups].join('-');
}
