import { fromBase64Url, toBase64Url } from '../encoding/base64url';
import { concatBytes, utf8 } from '../encoding/utf8';
import { reject } from '../errors';
import { isJsonObject, parseStrictJson } from '../json/strict-json';
import { sodium } from './sodium';

/**
 * Trust mode 2, passkeys (docs/CRYPTO.md §7): WebAuthn ES256 (ECDSA P-256 with SHA-256).
 *
 * libsodium has no P-256, so the one ECDSA verification goes through Web Crypto
 * (`globalThis.crypto.subtle`). Web Crypto is part of the platform (Node, browsers, Electron),
 * not a library; nothing else here uses it. Hashing is libsodium's SHA-256.
 */

export const WEBAUTHN_ALG = 'webauthn-es256';
/** Sizes after base64url decoding, docs/CRYPTO.md §7.2. */
export const MAX_AUTHENTICATOR_DATA = 1024;
export const MIN_AUTHENTICATOR_DATA = 37;
export const MAX_CLIENT_DATA_JSON = 2048;
export const MAX_DER_SIGNATURE = 80;
export const MAX_ORIGINS = 8;
export const MAX_ORIGIN_LENGTH = 300;
export const PASSKEY_POINT_LENGTH = 65;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/** The P-256 group order n, big-endian. */
const ORDER = fromHex(
  'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);

/** A passkey pinned in trust.json (docs/CRYPTO.md §7.1). */
export interface PinnedPasskeySigner {
  readonly kid: string;
  readonly alg: typeof WEBAUTHN_ALG;
  /** Uncompressed point 0x04 ‖ X ‖ Y, 65 bytes. */
  readonly publicKey: Uint8Array;
  readonly rpId: string;
  readonly origins: readonly string[];
}

/** The envelope entry of a passkey signature (docs/CRYPTO.md §7.2), all values base64url. */
export interface WebauthnSignatureEntry {
  readonly kid: string;
  readonly alg: typeof WEBAUTHN_ALG;
  readonly sig: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
}

function fromHex(text: string): Uint8Array {
  return new Uint8Array(
    (text.match(/../g) ?? []).map((pair) => parseInt(pair, 16)),
  );
}

// ---------------------------------------------------------------------------------------------
// rpId and origins

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const ALL_NUMERIC = /^[0-9.]+$/;
const APP_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const WEB_ORIGIN = new RegExp(
  `^https://(${LABEL}(?:\\.${LABEL})*)(?::([1-9][0-9]{0,4}))?$`,
);

function isDnsName(text: string): boolean {
  return text.length <= 253 && DNS_NAME.test(text) && !ALL_NUMERIC.test(text);
}

/** docs/CRYPTO.md §7.1: a lower-case DNS name of 1 to 253 characters, no IP address. */
export function isRpId(value: unknown): value is string {
  return typeof value === 'string' && isDnsName(value);
}

/** docs/CRYPTO.md §7.1: `https://<dns-name>[:<port>]` (port not 443) or `app://<name>`. */
export function isPasskeyOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  if (value.startsWith('app://')) return APP_NAME.test(value.slice(6));
  const match = WEB_ORIGIN.exec(value);
  if (match === null || !isDnsName(match[1] ?? '')) return false;
  const port = match[2];
  return port === undefined || (Number(port) <= 65535 && port !== '443');
}

// ---------------------------------------------------------------------------------------------
// DER

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let index = 0; index < a.length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Reads one INTEGER at `at`; returns the 32-byte big-endian value and the next position. */
function derInteger(
  der: Uint8Array,
  at: number,
): { value: Uint8Array; next: number } | null {
  if (der[at] !== 0x02) return null;
  const length = der[at + 1];
  if (length === undefined || length < 1 || length > 33) return null;
  const start = at + 2;
  const end = start + length;
  if (end > der.length) return null;
  let body = der.subarray(start, end);
  if ((body[0] ?? 0x80) >= 0x80) return null; // negative
  if (body.length > 1 && body[0] === 0 && (body[1] ?? 0) < 0x80) return null; // not minimal
  if (body[0] === 0) body = body.subarray(1);
  if (body.length > 32) return null;
  const value = new Uint8Array(32);
  value.set(body, 32 - body.length);
  return { value, next: end };
}

/**
 * Strict DER of an ECDSA signature (docs/CRYPTO.md §7.3 step 5): `SEQUENCE { INTEGER r, INTEGER s }`
 * in short-form lengths, minimal and positive integers, nothing after it, and 1 ≤ r, s ≤ n − 1.
 * Returns r ‖ s (64 bytes, what Web Crypto expects) or null. Low-S is not required.
 */
export function parseEcdsaDer(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der.length > MAX_DER_SIGNATURE) return null;
  if (
    der[0] !== 0x30 ||
    (der[1] ?? 0x80) >= 0x80 ||
    der[1] !== der.length - 2
  ) {
    return null;
  }
  const r = derInteger(der, 2);
  if (r === null) return null;
  const s = derInteger(der, r.next);
  if (s === null || s.next !== der.length) return null;
  for (const part of [r.value, s.value]) {
    if (compare(part, new Uint8Array(32)) === 0) return null;
    if (compare(part, ORDER) >= 0) return null;
  }
  return concatBytes(r.value, s.value);
}

function derPart(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const body = value.subarray(start);
  const padded =
    (body[0] ?? 0) >= 0x80 ? concatBytes(new Uint8Array(1), body) : body;
  return concatBytes(new Uint8Array([0x02, padded.length]), padded);
}

/** The canonical DER of r ‖ s (two 32-byte big-endian values) — what an authenticator returns. */
export function encodeEcdsaDer(rs: Uint8Array): Uint8Array {
  const body = concatBytes(
    derPart(rs.subarray(0, 32)),
    derPart(rs.subarray(32, 64)),
  );
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

// ---------------------------------------------------------------------------------------------
// Verification

interface SubtleLike {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: string; namedCurve: string },
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  verify(
    algorithm: { name: string; hash: string },
    key: unknown,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

function subtle(): SubtleLike {
  const platform = globalThis as { crypto?: { subtle?: SubtleLike } };
  const found = platform.crypto?.subtle;
  if (found === undefined) reject('signature_invalid'); // fail closed, never "pass"
  return found;
}

/** docs/CRYPTO.md §3: `webauthn-es256` kid input is the 65-byte uncompressed point. */
export function isPasskeyPoint(point: Uint8Array): boolean {
  return point.length === PASSKEY_POINT_LENGTH && point[0] === 0x04;
}

/**
 * docs/CRYPTO.md §7.3. `message` is M = "moat:bundle:v1\n" ‖ payloadBytes. Throws
 * `signature_invalid` for every failure; steps in the binding order of the spec (the caller did
 * step 1, kid pinned and alg equal).
 */
export async function verifyPasskeyEntry(
  signer: PinnedPasskeySigner,
  message: Uint8Array,
  entry: Pick<
    WebauthnSignatureEntry,
    'sig' | 'authenticatorData' | 'clientDataJSON'
  >,
): Promise<void> {
  const na = await sodium();
  // 2. strict base64url and sizes
  let sig: Uint8Array;
  let authenticatorData: Uint8Array;
  let clientDataJSON: Uint8Array;
  try {
    sig = fromBase64Url(entry.sig);
    authenticatorData = fromBase64Url(entry.authenticatorData);
    clientDataJSON = fromBase64Url(entry.clientDataJSON);
  } catch {
    reject('signature_invalid');
  }
  if (
    sig.length > MAX_DER_SIGNATURE ||
    authenticatorData.length < MIN_AUTHENTICATOR_DATA ||
    authenticatorData.length > MAX_AUTHENTICATOR_DATA ||
    clientDataJSON.length < 1 ||
    clientDataJSON.length > MAX_CLIENT_DATA_JSON
  ) {
    reject('signature_invalid');
  }

  // 3. clientDataJSON: extra keys are fine here and only here.
  let client;
  try {
    client = parseStrictJson(clientDataJSON);
  } catch {
    reject('signature_invalid');
  }
  if (!isJsonObject(client)) reject('signature_invalid');
  const challenge = toBase64Url(na.crypto_hash_sha256(message));
  const origin = client['origin'];
  if (
    client['type'] !== 'webauthn.get' ||
    client['challenge'] !== challenge ||
    typeof origin !== 'string' ||
    !signer.origins.includes(origin) ||
    (Object.hasOwn(client, 'crossOrigin') && client['crossOrigin'] !== false)
  ) {
    reject('signature_invalid');
  }

  // 4. authenticatorData: rpIdHash, UP and UV.
  const rpIdHash = na.crypto_hash_sha256(utf8(signer.rpId));
  const flags = authenticatorData[32] ?? 0;
  if (
    !na.memcmp(authenticatorData.subarray(0, 32), rpIdHash) ||
    (flags & FLAG_UP) === 0 ||
    (flags & FLAG_UV) === 0
  ) {
    reject('signature_invalid');
  }

  // 5. strict DER, 6. ECDSA over authenticatorData ‖ SHA-256(clientDataJSON).
  const rs = parseEcdsaDer(sig);
  if (rs === null || !isPasskeyPoint(signer.publicKey)) {
    reject('signature_invalid');
  }
  let valid = false;
  try {
    const key = await subtle().importKey(
      'raw',
      signer.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    valid = await subtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      rs,
      concatBytes(authenticatorData, na.crypto_hash_sha256(clientDataJSON)),
    );
  } catch {
    valid = false; // a point off the curve, or no Web Crypto: closed
  }
  if (!valid) reject('signature_invalid');
}

/**
 * The envelope entry from what `navigator.credentials.get` returned: `signature` is the DER
 * signature of the AuthenticatorAssertionResponse, the other two its `authenticatorData` and
 * `clientDataJSON` bytes. The challenge must have been `webauthnChallenge(payloadBytes)`.
 */
export function webauthnSignature(input: {
  readonly kid: string;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly signature: Uint8Array;
}): WebauthnSignatureEntry {
  return {
    kid: input.kid,
    alg: WEBAUTHN_ALG,
    sig: toBase64Url(input.signature),
    authenticatorData: toBase64Url(input.authenticatorData),
    clientDataJSON: toBase64Url(input.clientDataJSON),
  };
}
