import { z } from 'zod';
import { fromBase64Url } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import {
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';
import { BODY_FIELD_NAME } from './body';

/**
 * Client protection per route (FR-16): who may call a route at all, checked by the gate before it
 * opens the upstream's secret. A closed list of checks, all optional, every one that is set must
 * pass; a failure answers 401 `client_unauthorized` and sends nothing.
 *
 * - `apiKey`: the caller sends a key in a header; the gate compares it in constant time with a
 *   sealed secret of the bundle (server-to-server callers, never a key in a public page).
 * - `jwt`: `Authorization: Bearer <JWT>` signed by one of the listed public keys (EdDSA, ES256,
 *   RS256; the algorithm comes from the key, never from the token), with `iss`, `aud` and `exp`.
 * - `turnstile`: a Cloudflare Turnstile token in a header, which the gate checks at `verifyUrl`
 *   with a sealed secret (a POST the local policy must allow, like any other call).
 * - `honeypot`: a JSON body field a person never fills; a body where it is not empty is refused.
 *
 * Everything here is data: keys are public keys, secrets are names (SEC-20, SEC-31).
 */

export const JWT_ALGS = ['EdDSA', 'ES256', 'RS256'] as const;
export type JwtAlg = (typeof JWT_ALGS)[number];
export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const DEFAULT_API_KEY_HEADER = 'X-Api-Key';
export const DEFAULT_TURNSTILE_HEADER = 'X-Turnstile-Token';
/** At most this many keys per route: enough for a rotation. */
export const MAX_JWT_KEYS = 8;
/** Seconds a token's `exp` and `nbf` may be off (clock skew). */
export const JWT_LEEWAY_SECONDS = 60;
/** The longest token the gate reads. */
export const MAX_JWT_LENGTH = 8192;

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Headers a client check may not read: the gate's own, and those a browser sets itself. */
const RESERVED = new Set([
  'host',
  'content-type',
  'content-length',
  'transfer-encoding',
  'connection',
  'origin',
  'cookie',
  'access-control-request-method',
  'access-control-request-headers',
]);
const VISIBLE = /^[\x21-\x7E]{1,256}$/;
const KID = /^[A-Za-z0-9._-]{1,128}$/;

const headerName = z
  .string()
  .regex(HEADER_NAME)
  .refine((value) => !RESERVED.has(value.toLowerCase()));

/** SubjectPublicKeyInfo prefixes of the fixed-size keys (RFC 8410, RFC 5480). */
const ED25519_SPKI = '302a300506032b6570032100';
const P256_SPKI = '3059301306072a8648ce3d020106082a8648ce3d03010703420004';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * A public key as base64url DER SubjectPublicKeyInfo of its algorithm: Ed25519 (44 bytes), P-256
 * uncompressed (91 bytes), or RSA with 2048 to 8192 bits (a DER sequence of 290 to 1100 bytes).
 */
export function isSpkiFor(alg: JwtAlg, value: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch (error) {
    if (error instanceof MoatRejection) return false;
    throw error;
  }
  if (alg === 'EdDSA')
    return bytes.length === 44 && hex(bytes.subarray(0, 12)) === ED25519_SPKI;
  if (alg === 'ES256')
    return bytes.length === 91 && hex(bytes.subarray(0, 27)) === P256_SPKI;
  return bytes.length >= 290 && bytes.length <= 1100 && bytes[0] === 0x30;
}

const jwtKeySchema = z
  .strictObject({
    kid: z.string().regex(KID),
    alg: z.enum(JWT_ALGS),
    spki: z.string().max(1500),
  })
  .refine((key) => isSpkiFor(key.alg, key.spki), {
    message: 'spki is not a public key of this alg',
    path: ['spki'],
  });

/** An HTTPS origin and a path of plain segments, as an OAuth2 `tokenUrl` (compiled.ts). */
export type UrlCheck = (value: string) => boolean;

export function clientSchemaWith(isUrl: UrlCheck) {
  return z
    .strictObject({
      apiKey: z
        .strictObject({ header: headerName, secret: z.string().regex(NAME) })
        .optional(),
      jwt: z
        .strictObject({
          issuer: z.string().regex(VISIBLE),
          audience: z.string().regex(VISIBLE),
          keys: z
            .array(jwtKeySchema)
            .min(1)
            .max(MAX_JWT_KEYS)
            .refine(
              (keys) =>
                new Set(keys.map((key) => key.kid)).size === keys.length,
              'two keys with the same kid',
            ),
        })
        .optional(),
      turnstile: z
        .strictObject({
          header: headerName,
          secret: z.string().regex(NAME),
          verifyUrl: z.string().refine(isUrl),
        })
        .optional(),
      honeypot: z
        .strictObject({ field: z.string().regex(BODY_FIELD_NAME) })
        .optional(),
    })
    .refine((client) => Object.keys(client).length > 0, 'no check');
}

/**
 * As moat.yaml writes it: `apiKey.header` defaults to DEFAULT_API_KEY_HEADER, `turnstile.header`
 * to DEFAULT_TURNSTILE_HEADER and `verifyUrl` to Cloudflare's (TURNSTILE_VERIFY_URL).
 */
export function clientYamlSchemaWith(isUrl: UrlCheck) {
  const compiled = clientSchemaWith(isUrl).shape;
  return z
    .strictObject({
      apiKey: z
        .strictObject({
          header: headerName.optional(),
          secret: z.string().regex(NAME),
        })
        .optional(),
      jwt: compiled.jwt,
      turnstile: z
        .strictObject({
          header: headerName.optional(),
          secret: z.string().regex(NAME),
          verifyUrl: z.string().refine(isUrl).optional(),
        })
        .optional(),
      honeypot: compiled.honeypot,
    })
    .refine((client) => Object.keys(client).length > 0, 'no check');
}

export type ClientProtectionInput = z.infer<
  ReturnType<typeof clientYamlSchemaWith>
>;

/** moat.yaml's `client` with every default filled in, as the bundle carries it. */
export function compileClient(input: ClientProtectionInput): ClientProtection {
  return {
    ...(input.apiKey === undefined
      ? {}
      : {
          apiKey: {
            header: input.apiKey.header ?? DEFAULT_API_KEY_HEADER,
            secret: input.apiKey.secret,
          },
        }),
    ...(input.jwt === undefined ? {} : { jwt: input.jwt }),
    ...(input.turnstile === undefined
      ? {}
      : {
          turnstile: {
            header: input.turnstile.header ?? DEFAULT_TURNSTILE_HEADER,
            secret: input.turnstile.secret,
            verifyUrl: input.turnstile.verifyUrl ?? TURNSTILE_VERIFY_URL,
          },
        }),
    ...(input.honeypot === undefined ? {} : { honeypot: input.honeypot }),
  };
}

export interface ClientProtection {
  readonly apiKey?: { readonly header: string; readonly secret: string };
  readonly jwt?: {
    readonly issuer: string;
    readonly audience: string;
    readonly keys: readonly {
      readonly kid: string;
      readonly alg: JwtAlg;
      readonly spki: string;
    }[];
  };
  readonly turnstile?: {
    readonly header: string;
    readonly secret: string;
    readonly verifyUrl: string;
  };
  readonly honeypot?: { readonly field: string };
}

/**
 * Why a route cannot have this client protection: the JWT and the API key both in
 * `Authorization`, or a honeypot on a route that takes no JSON body. Null when it can.
 */
export function clientRouteProblem(
  client: ClientProtection,
  route: { readonly method: string; readonly contentTypes: readonly string[] },
): string | null {
  if (
    client.jwt !== undefined &&
    client.apiKey?.header.toLowerCase() === 'authorization'
  )
    return '`apiKey.header` may not be Authorization next to `jwt`';
  if (
    client.honeypot !== undefined &&
    (!['POST', 'PUT', 'PATCH'].includes(route.method) ||
      route.contentTypes.length !== 1 ||
      route.contentTypes[0] !== 'application/json')
  )
    return '`honeypot` needs a POST, PUT or PATCH route that takes JSON only';
  return null;
}

/** The secrets a route's client checks open. */
export function clientSecrets(
  client:
    | {
        readonly apiKey?: { readonly secret: string };
        readonly turnstile?: { readonly secret: string };
      }
    | undefined,
): string[] {
  if (client === undefined) return [];
  return [client.apiKey?.secret, client.turnstile?.secret].filter(
    (name): name is string => name !== undefined,
  );
}

/**
 * FR-16: the honeypot of a JSON body. True when the body is a JSON object whose `field` is
 * present with anything but `""` or `null` — a person never fills it. A body that is not a
 * strict JSON object (http/body.ts) is left to the route's other checks.
 */
export function honeypotFilled(field: string, body: string): boolean {
  let value: JsonValue;
  try {
    value = parseStrictJson(utf8(body));
  } catch (error) {
    if (error instanceof MoatRejection) return false;
    throw error;
  }
  if (!isJsonObject(value) || !Object.hasOwn(value, field)) return false;
  const filled = value[field];
  return filled !== '' && filled !== null;
}
