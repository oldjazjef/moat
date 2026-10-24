import { z } from 'zod';

/**
 * The identity providers an operator allows for single sign-on (SEC-51, T-104): the variable
 * `MOAT_OIDC_PROVIDERS` (or the file `MOAT_OIDC_PROVIDERS_FILE`, which keeps the client secrets out
 * of the environment) holds a JSON array. Pure: validation only, no network.
 */
export interface OidcProvider {
  /** Lower case, appears in URLs and in `account_identity.provider`. */
  readonly id: string;
  /** What the button says. */
  readonly name: string;
  /** The issuer exactly as the provider's discovery document names it. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export const MAX_OIDC_PROVIDERS = 5;

const noControl = (value: string): boolean =>
  [...value].every((c) => {
    const code = c.charCodeAt(0);
    return code > 0x1f && code !== 0x7f;
  });

/** https, or http on this machine outside production (development against a local provider). */
export function isAllowedUrl(
  text: string,
  allowLoopbackHttp: boolean,
): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '')
    return false;
  if (url.protocol === 'https:')
    return !isPrivateHost(url.hostname) || allowLoopbackHttp;
  return (
    allowLoopbackHttp &&
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  );
}

/** Literal private, loopback and link-local addresses, and `localhost`: no DNS lookup is done here. */
export function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (
    name === '::1' ||
    name.startsWith('fc') ||
    name.startsWith('fd') ||
    name.startsWith('fe80')
  )
    return name.includes(':');
  const parts = name.split('.').map(Number);
  if (
    parts.length === 4 &&
    parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)
  ) {
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  return false;
}

export class OidcConfigError extends Error {}

/** Throws OidcConfigError (never echoing a value) on anything wrong; an empty text means "none". */
export function parseOidcProviders(
  text: string | undefined,
  allowLoopbackHttp: boolean,
): readonly OidcProvider[] {
  if (text === undefined || text.trim() === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OidcConfigError('not JSON');
  }
  const schema = z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
          name: z.string().min(1).max(40).refine(noControl),
          issuer: z
            .string()
            .max(300)
            .refine((v) => isAllowedUrl(v, allowLoopbackHttp))
            .refine((v) => !v.includes('?')),
          clientId: z.string().min(1).max(256).refine(noControl),
          clientSecret: z.string().min(1).max(512).refine(noControl),
        })
        .strict(),
    )
    .max(MAX_OIDC_PROVIDERS)
    .refine((list) => new Set(list.map((p) => p.id)).size === list.length);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new OidcConfigError('invalid');
  return parsed.data;
}
