import { z } from 'zod';
import { bodyFieldsSchema, bodySchemaProblem } from '../http/body';
import { budgetSchema } from '../http/budget';
import { MEDIA_TYPE } from '../http/content-type';
import { normalisePath } from '../http/path';
import { MoatRejection, reject } from '../errors';
import { hasProtoKey, type JsonValue } from '../json/strict-json';

/**
 * The compiled config inside a bundle (docs/CRYPTO.md §4.1 `config`): what a gate validates in
 * step 9 and enforces. Strict everywhere (SEC-20): an unknown key, a wrong type or a dangling
 * reference rejects the bundle with `config_invalid`. Every gate implements exactly these rules
 * (conformance/vectors/config/config.json).
 */

/** Route, upstream and secret names (CLAUDE.md, YAML standards). */
export const NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const QUERY_PARAM = /^[A-Za-z0-9_.-]{1,64}$/;
/** Headers the gate sets itself; an auth header may not replace them. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'transfer-encoding',
  'connection',
  'te',
  'upgrade',
  'user-agent',
  'accept',
  'accept-encoding',
  'cookie',
  'proxy-authorization',
]);

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_TIMEOUT_MS = 60_000;
export const MAX_ORIGINS = 16;
/** Rate limits (FR-30): at most this many requests in a window of at most one day. */
export const MAX_LIMIT_REQUESTS = 1_000_000;
export const MAX_WINDOW_SECONDS = 86_400;
export const LIMIT_SCOPES = ['ip', 'route'] as const;
/** Quotas (FR-31): calendar periods in UTC; a period resets at its first second. */
export const QUOTA_PERIODS = ['day', 'month'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export const JSON_TYPE = 'application/json';
const name = z.string().regex(NAME);
const mediaType = z.string().regex(MEDIA_TYPE);
const routePath = z.string().refine(isRoutePath);

const auth = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bearer'), secret: name }),
  z.strictObject({
    type: z.literal('header'),
    name: z
      .string()
      .regex(HEADER_NAME)
      .refine((value) => !RESERVED_HEADERS.has(value.toLowerCase())),
    secret: name,
  }),
  z.strictObject({
    type: z.literal('query'),
    param: z.string().regex(QUERY_PARAM),
    secret: name,
  }),
]);

/** `requests` per `windowSeconds`, counted from the first request of a window (FR-30). */
export const limitSchema = z.strictObject({
  requests: z.int().min(1).max(MAX_LIMIT_REQUESTS),
  windowSeconds: z.int().min(1).max(MAX_WINDOW_SECONDS),
});

/**
 * A quota (FR-31, T-07): at most `requests` per calendar day or month in UTC, counted for the
 * whole route (or, in the local policy, the whole gate), whoever calls.
 */
export const quotaSchema = z.strictObject({
  requests: z.int().min(1).max(MAX_LIMIT_REQUESTS),
  period: z.enum(QUOTA_PERIODS),
});

export const compiledUpstreamSchema = z.strictObject({
  origin: z.string().refine(isOrigin),
  auth: z.union([auth, z.null()]),
  timeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS),
});

export const compiledRouteSchema = z.strictObject({
  method: z.enum(METHODS),
  path: routePath,
  upstream: name,
  upstreamPath: routePath,
  maxBodyBytes: z.int().min(0).max(MAX_BODY_BYTES),
  contentTypes: z.array(mediaType).min(1).max(8),
  responseContentTypes: z.array(mediaType).min(1).max(8),
  enabled: z.boolean(),
  /**
   * FR-15: the browser origins that may call this route cross-origin. Empty = no CORS answer; a
   * request with an `Origin` outside a non-empty list is refused before anything is forwarded.
   * Binds browsers only, not `curl` (T-01, SEC-58).
   */
  origins: z.array(z.string().refine(isWebOrigin)).max(MAX_ORIGINS),
  /** FR-30: per client IP or for the whole route; null = only the local policy's limits. */
  rateLimit: z.union([
    z.strictObject({
      ...limitSchema.shape,
      per: z.enum(LIMIT_SCOPES),
    }),
    z.null(),
  ]),
  /**
   * FR-31: requests per calendar day or month for the whole route. Compiled only when set, so
   * bundles without a quota are unchanged; a gate that does not know the key refuses the bundle.
   */
  quota: quotaSchema.optional(),
  /**
   * FR-31 for AI APIs: tokens and/or cost per calendar day or month, read from the usage the
   * answer reports (http/budget.ts). Compiled only when set. The route must answer JSON only.
   */
  budget: budgetSchema.optional(),
  /**
   * FR-13: the fields of the JSON object the website sends (http/body.ts); the gate forwards only
   * these and refuses a body that does not fit. Compiled only when set: without it the body is
   * forwarded as received. Only on POST, PUT and PATCH routes that accept JSON alone.
   */
  body: bodyFieldsSchema.optional(),
});

/** Methods whose requests carry a body the gate forwards. */
export const BODY_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH'];

export const compiledConfigSchema = z.strictObject({
  version: z.literal(1),
  /**
   * `false` locks the gate: it answers every request with `gate_disabled` and forwards nothing
   * (the lock of a gate or of its whole environment, moat.yaml `environments`). Compiled only
   * when locked, so bundles of an unlocked gate are unchanged; absent = `true`.
   */
  enabled: z.boolean().optional(),
  upstreams: z.record(name, compiledUpstreamSchema),
  routes: z.record(name, compiledRouteSchema),
});

export type CompiledConfig = z.infer<typeof compiledConfigSchema>;
export type CompiledRoute = z.infer<typeof compiledRouteSchema>;
export type CompiledUpstream = z.infer<typeof compiledUpstreamSchema>;

/** SEC-27: at most this many routes of a config have a budget. */
export const MAX_ROUTE_BUDGETS = 256;

/**
 * Validates a compiled config against the bundle's secret names. Throws `config_invalid`.
 * Besides the shape: every route's upstream exists, every referenced secret is in the bundle, and
 * no two routes share method and path, budgets only on JSON routes and at most MAX_ROUTE_BUDGETS.
 */
export function validateCompiledConfig(
  config: JsonValue,
  secretNames: readonly string[],
): CompiledConfig {
  if (hasProtoKey(config)) reject('config_invalid');
  const parsed = compiledConfigSchema.safeParse(config);
  if (!parsed.success) reject('config_invalid');
  const result = parsed.data;
  const seen = new Set<string>();
  for (const route of Object.values(result.routes)) {
    if (!Object.hasOwn(result.upstreams, route.upstream))
      reject('config_invalid');
    // A budget is counted from the usage in a JSON answer; any other answer cannot be counted.
    if (
      route.budget !== undefined &&
      !route.responseContentTypes.every((type) => type === JSON_TYPE)
    )
      reject('config_invalid');
    if (route.body !== undefined && bodyRouteProblem(route) !== null)
      reject('config_invalid');
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) reject('config_invalid');
    seen.add(key);
  }
  // SEC-27: the gate's budget store holds every route budget next to the policy's host budgets.
  if (
    Object.values(result.routes).filter((route) => route.budget !== undefined)
      .length > MAX_ROUTE_BUDGETS
  )
    reject('config_invalid');
  for (const upstream of Object.values(result.upstreams)) {
    if (upstream.auth !== null && !secretNames.includes(upstream.auth.secret))
      reject('config_invalid');
  }
  return result;
}

/**
 * Why a route cannot have its `body` (FR-13): the method sends no body, the route accepts more
 * than JSON, or the fields break a limit of http/body.ts. Null when it can.
 */
export function bodyRouteProblem(
  route: Pick<CompiledRoute, 'method' | 'contentTypes' | 'body'>,
): string | null {
  if (route.body === undefined) return null;
  if (!BODY_METHODS.includes(route.method))
    return '`body` needs method POST, PUT or PATCH';
  if (route.contentTypes.length !== 1 || route.contentTypes[0] !== JSON_TYPE)
    return '`body` needs `contentTypes: [application/json]` (the default)';
  return bodySchemaProblem(route.body);
}

/** A path as routes and upstream paths are written: already normalised, no trailing "/". */
function isRoutePath(value: string): boolean {
  try {
    return (
      normalisePath(value) === value && (value === '/' || !value.endsWith('/'))
    );
  } catch (error) {
    if (error instanceof MoatRejection) return false;
    throw error;
  }
}

/**
 * `https://host[:port]`: lower-case DNS name (labels of 1–63 `[a-z0-9-]`, no leading or trailing
 * "-", the last label not all digits, so no IPv4 literal), optional port 1–65535 without leading
 * zero and never the default 443, no path, no user info.
 */
export function isOrigin(value: string): boolean {
  const match = /^https:\/\/([^:/?#@]+)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (match === null) return false;
  const host = match[1] ?? '';
  const port = match[2];
  if (port !== undefined && (Number(port) > 65535 || port === '443'))
    return false;
  if (host.length > 253) return false;
  const labels = host.split('.');
  if (
    !labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    return false;
  return !/^[0-9]+$/.test(labels.at(-1) ?? '');
}

/**
 * A browser origin as a route lists it and a browser sends it: an HTTPS origin as isOrigin(), or
 * `http://localhost[:port]` / `http://127.0.0.1[:port]` for local development. No wildcard, no
 * path, no trailing "/".
 */
export function isWebOrigin(value: string): boolean {
  if (isOrigin(value)) return true;
  const match =
    /^http:\/\/(?:localhost|127\.0\.0\.1)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  return (
    match !== null && Number(match[1] ?? '80') <= 65535 && match[1] !== '80'
  );
}

/** `host[:port]` of an origin — the key of the local policy's upstream allowlist. */
export function hostKey(origin: string): string {
  return origin.slice('https://'.length);
}
