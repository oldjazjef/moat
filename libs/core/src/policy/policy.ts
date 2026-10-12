import { z } from 'zod';
import {
  hostKey,
  isOrigin,
  limitSchema,
  MAX_BODY_BYTES,
  MAX_TIMEOUT_MS,
  METHODS,
  NAME,
  type CompiledConfig,
} from '../config/compiled';
import { reject } from '../errors';
import { normalisePath } from '../http/path';
import { hasProtoKey, type JsonValue } from '../json/strict-json';

/**
 * The gate's local policy (SEC-10 to SEC-14): written only on the gate's server, never by the
 * Cloud. A bundle whose config goes beyond it is rejected as a whole (`policy_violation`), even
 * with a valid signature (SEC-11) — so the config in force is always within the policy.
 * conformance/vectors/config/policy.json holds the shared cases.
 */

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** SEC-27: the rate-limit store holds at most this many counters (about 1 MiB on disk). */
export const MAX_TRACKED_CLIENTS = 20_000;

const hostKeySchema = z.string().refine((key) => isOrigin(`https://${key}`));
const prefix = z.string().refine((value) => {
  try {
    return normalisePath(value) === value;
  } catch {
    return false;
  }
});

export const policySchema = z.strictObject({
  v: z.literal(1),
  /**
   * Allowed upstreams by `host[:port]`, each with the path prefixes and methods it may use and
   * the secrets that may be sent to it (SEC-35): a bundle cannot point a secret at another host.
   */
  upstreams: z.record(
    hostKeySchema,
    z.strictObject({
      pathPrefixes: z.array(prefix).min(1).max(64),
      methods: z.array(z.enum(METHODS)).min(1),
      secrets: z.array(z.string().regex(NAME)).max(16),
    }),
  ),
  maxBodyBytes: z.int().min(0).max(MAX_BODY_BYTES),
  maxResponseBytes: z.int().min(1).max(MAX_RESPONSE_BYTES),
  maxTimeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS),
  /**
   * Rate limits the gate enforces on every route, whatever the bundle says (SEC-14, SEC-45,
   * T-21): a bundle can add stricter limits per route but never lift these. `perIp` counts each
   * client address (SEC-26: `REMOTE_ADDR` only), `total` all requests together. `maxClients`
   * bounds the counter store; when it is full, new clients are refused (SEC-27, fail closed).
   */
  limits: z.strictObject({
    perIp: limitSchema,
    total: limitSchema,
    maxClients: z.int().min(100).max(MAX_TRACKED_CLIENTS),
  }),
  /**
   * Local test setups only (the conformance runner, a demo): send these `host[:port]`s to a fixed
   * IP — loopback included — and trust an extra CA file. Never set by a bundle; the hardening
   * check reports a gate with this block as unsafe for real secrets.
   */
  testing: z
    .strictObject({
      resolve: z.record(
        hostKeySchema,
        z.string().regex(/^(?:127\.0\.0\.1|::1)$/),
      ),
      caFile: z.string().min(1).max(4096).nullable(),
    })
    .optional(),
});

export type Policy = z.infer<typeof policySchema>;

/** Throws `policy_invalid`; a gate without a valid policy serves nothing (SEC-46). */
export function parsePolicy(value: JsonValue): Policy {
  if (hasProtoKey(value)) reject('policy_invalid');
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) reject('policy_invalid');
  return parsed.data;
}

/** True when `path` equals the prefix or continues it at a segment boundary. */
export function matchesPrefix(path: string, pathPrefix: string): boolean {
  if (pathPrefix === '/' || path === pathPrefix) return true;
  const base = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
  return path.startsWith(base);
}

/** Throws `policy_violation` unless every upstream, route and limit lies within the policy. */
export function checkPolicy(config: CompiledConfig, policy: Policy): void {
  for (const upstream of Object.values(config.upstreams)) {
    if (upstream.timeoutMs > policy.maxTimeoutMs) reject('policy_violation');
    // SEC-35: a secret goes only to a host the policy binds it to.
    if (upstream.auth !== null) {
      const allowed = policy.upstreams[hostKey(upstream.origin)];
      if (
        allowed === undefined ||
        !allowed.secrets.includes(upstream.auth.secret)
      )
        reject('policy_violation');
    }
  }
  for (const route of Object.values(config.routes)) {
    const upstream = config.upstreams[route.upstream];
    if (upstream === undefined) reject('policy_violation');
    const allowed = policy.upstreams[hostKey(upstream.origin)];
    if (allowed === undefined) reject('policy_violation');
    if (!allowed.methods.includes(route.method)) reject('policy_violation');
    if (
      !allowed.pathPrefixes.some((pathPrefix) =>
        matchesPrefix(route.upstreamPath, pathPrefix),
      )
    ) {
      reject('policy_violation');
    }
    if (route.maxBodyBytes > policy.maxBodyBytes) reject('policy_violation');
  }
  if (counterCapacity(config, policy) > policy.limits.maxClients)
    reject('policy_violation');
}

/**
 * SEC-27: the most counters the gate can hold at once with this config, so a full store — which
 * refuses every new client — cannot be reached by flooding. A counter is created only for a
 * request that passes the `total` limit, so per kind of per-IP counter (the policy's, and each
 * route limited per IP) at most `total.requests × (⌈window / total.windowSeconds⌉ + 1)` are alive
 * at once; plus one per route limited as a whole, plus `total` itself.
 */
export function counterCapacity(
  config: CompiledConfig,
  policy: Policy,
): number {
  const { total, perIp } = policy.limits;
  const live = (windowSeconds: number) =>
    total.requests * (Math.ceil(windowSeconds / total.windowSeconds) + 1);
  let count = 1 + live(perIp.windowSeconds);
  for (const route of Object.values(config.routes)) {
    if (route.rateLimit === null) continue;
    count +=
      route.rateLimit.per === 'ip' ? live(route.rateLimit.windowSeconds) : 1;
  }
  return count;
}

/** What `moat policy suggest` proposes: enough for a contact form, little for an abuser. */
export const DEFAULT_LIMITS: Policy['limits'] = {
  perIp: { requests: 30, windowSeconds: 60 },
  total: { requests: 600, windowSeconds: 60 },
  maxClients: 10_000,
};

/**
 * SEC-14: the narrowest policy that admits this config — what `moat policy suggest` prints and a
 * recipe ships, for the admin to review and install on the gate.
 */
export function suggestPolicy(config: CompiledConfig): Policy {
  const upstreams: Policy['upstreams'] = {};
  for (const route of Object.values(config.routes)) {
    const upstream = config.upstreams[route.upstream];
    if (upstream === undefined) continue;
    const entry = (upstreams[hostKey(upstream.origin)] ??= {
      pathPrefixes: [],
      methods: [],
      secrets: [],
    });
    if (upstream.auth !== null && !entry.secrets.includes(upstream.auth.secret))
      entry.secrets.push(upstream.auth.secret);
    if (!entry.pathPrefixes.includes(route.upstreamPath))
      entry.pathPrefixes.push(route.upstreamPath);
    if (!entry.methods.includes(route.method)) entry.methods.push(route.method);
  }
  const routes = Object.values(config.routes);
  const policy: Policy = {
    v: 1,
    upstreams,
    maxBodyBytes: Math.max(0, ...routes.map((route) => route.maxBodyBytes)),
    maxResponseBytes: 1024 * 1024,
    maxTimeoutMs: Math.max(
      1,
      ...Object.values(config.upstreams).map((upstream) => upstream.timeoutMs),
    ),
    limits: DEFAULT_LIMITS,
  };
  const needed = counterCapacity(config, policy);
  if (needed > policy.limits.maxClients)
    policy.limits = {
      ...policy.limits,
      maxClients: Math.min(MAX_TRACKED_CLIENTS, needed),
    };
  return policy;
}
