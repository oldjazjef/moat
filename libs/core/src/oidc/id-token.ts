import { fromBase64Url, toBase64Url } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import { sodium } from '../crypto/sodium';

/**
 * Checking an OpenID Connect ID token for Moat Cloud's single sign-on (SEC-51, T-104). Pure: the
 * caller fetched the keys and passes the time. Only what a relying party must check, with a short
 * closed list of choices: RS256 and ES256 (never `none`, never a shared-secret algorithm), the
 * issuer, the audience, the expiry and the nonce. The signature is made and checked with the
 * platform's Web Crypto — Moat adds no JWT library.
 */

export const MAX_ID_TOKEN_BYTES = 16 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const MIN_RSA_BITS = 2048;

export interface Jwk {
  readonly kty?: unknown;
  readonly kid?: unknown;
  readonly use?: unknown;
  readonly alg?: unknown;
  readonly n?: unknown;
  readonly e?: unknown;
  readonly crv?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
}

export type IdTokenErrorCode =
  | 'malformed'
  | 'algorithm'
  | 'key'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'nonce'
  | 'claims';

export class IdTokenError extends Error {
  override readonly name = 'IdTokenError';
  constructor(readonly code: IdTokenErrorCode) {
    super(code);
  }
}

const fail = (code: IdTokenErrorCode): never => {
  throw new IdTokenError(code);
};

export interface IdTokenExpectation {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  /** Unix seconds. */
  readonly now: number;
}

export interface IdTokenClaims {
  readonly subject: string;
  /** Present only when the provider sent a string. */
  readonly email: string | null;
  /** True only for the boolean `true` (or the string "true"): anything else is "not verified". */
  readonly emailVerified: boolean;
}

interface SubtleKeyApi {
  importKey(
    format: 'jwk',
    keyData: Record<string, unknown>,
    algorithm: Record<string, unknown>,
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  verify(
    algorithm: Record<string, unknown>,
    key: unknown,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

function webCrypto(): SubtleKeyApi {
  const found = (
    globalThis as unknown as { crypto?: { subtle?: SubtleKeyApi } }
  ).crypto?.subtle;
  // Fail closed: no Web Crypto means no sign-in, never an unchecked one.
  return found ?? fail('signature');
}

function jsonPart(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(text)),
    );
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return fail('malformed');
    return value as Record<string, unknown>;
  } catch {
    return fail('malformed');
  }
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max;

/** The keys that could have signed a token with this header, `alg` already checked. */
function candidates(
  keys: readonly Jwk[],
  alg: 'RS256' | 'ES256',
  kid: unknown,
): Jwk[] {
  const kty = alg === 'RS256' ? 'RSA' : 'EC';
  const fitting = keys.filter(
    (key) =>
      key.kty === kty &&
      (key.use === undefined || key.use === 'sig') &&
      (key.alg === undefined || key.alg === alg) &&
      (alg !== 'ES256' || key.crv === 'P-256'),
  );
  if (kid === undefined) return fitting.length === 1 ? fitting : [];
  return fitting.filter((key) => key.kid === kid);
}

function rsaBits(key: Jwk): number {
  if (typeof key.n !== 'string') return 0;
  try {
    const modulus = fromBase64Url(key.n);
    const first = modulus.findIndex((byte) => byte !== 0);
    if (first < 0) return 0;
    return (modulus.length - first) * 8 - Math.clz32(modulus[first] ?? 0) + 24;
  } catch {
    return 0;
  }
}

/**
 * Verifies the compact JWT and returns the claims Moat uses. Throws IdTokenError for every
 * failure; the caller shows one plain "sign-in failed" and never the code.
 */
export async function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  expect: IdTokenExpectation,
): Promise<IdTokenClaims> {
  if (token.length > MAX_ID_TOKEN_BYTES) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === ''))
    return fail('malformed');
  const [headerText, payloadText, signatureText] = parts as [
    string,
    string,
    string,
  ];
  if (!/^[A-Za-z0-9_-]+$/.test(headerText + payloadText + signatureText))
    return fail('malformed');
  const header = jsonPart(headerText);
  const alg = header['alg'];
  if (alg !== 'RS256' && alg !== 'ES256') return fail('algorithm');

  const matching = candidates(keys, alg, header['kid']);
  if (matching.length === 0) return fail('key');
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(signatureText);
  } catch {
    return fail('malformed');
  }
  if (alg === 'ES256' && signature.length !== 64) return fail('signature');
  const signed = utf8(`${headerText}.${payloadText}`);
  const subtle = webCrypto();
  let valid = false;
  for (const jwk of matching) {
    if (alg === 'RS256' && rsaBits(jwk) < MIN_RSA_BITS) continue;
    try {
      const key = await subtle.importKey(
        'jwk',
        {
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e,
          crv: jwk.crv,
          x: jwk.x,
          y: jwk.y,
          ext: true,
        },
        alg === 'RS256'
          ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
          : { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      valid = await subtle.verify(
        alg === 'RS256'
          ? { name: 'RSASSA-PKCS1-v1_5' }
          : { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signature,
        signed,
      );
    } catch {
      valid = false;
    }
    if (valid) break;
  }
  if (!valid) return fail('signature');

  const claims = jsonPart(payloadText);
  if (claims['iss'] !== expect.issuer) return fail('issuer');
  const aud = claims['aud'];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expect.clientId)) return fail('audience');
  if (audiences.length > 1 && claims['azp'] !== expect.clientId)
    return fail('audience');
  const exp = claims['exp'];
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < expect.now)
    return fail('expired');
  for (const name of ['iat', 'nbf'] as const) {
    const value = claims[name];
    if (value !== undefined) {
      if (typeof value !== 'number') return fail('claims');
      if (value > expect.now + CLOCK_SKEW_SECONDS) return fail('expired');
    }
  }
  if (claims['nonce'] !== expect.nonce) return fail('nonce');
  const subject = claims['sub'];
  if (!isText(subject, 255)) return fail('claims');
  const email = claims['email'];
  const verified = claims['email_verified'];
  return {
    subject,
    email: isText(email, 254) ? email : null,
    emailVerified: verified === true || verified === 'true',
  };
}

/** PKCE (RFC 7636) S256: base64url of the SHA-256 of the verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const na = await sodium();
  return toBase64Url(na.crypto_hash_sha256(utf8(verifier)));
}
