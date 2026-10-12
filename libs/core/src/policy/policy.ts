import { z } from 'zod';
import {
  hostKey,
  isOrigin,
  MAX_BODY_BYTES,
  MAX_TIMEOUT_MS,
  METHODS,
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
  /** Allowed upstreams by `host[:port]`, each with the path prefixes and methods it may use. */
  upstreams: z.record(
    hostKeySchema,
    z.strictObject({
      pathPrefixes: z.array(prefix).min(1).max(64),
      methods: z.array(z.enum(METHODS)).min(1),
    }),
  ),
  maxBodyBytes: z.int().min(0).max(MAX_BODY_BYTES),
  maxResponseBytes: z.int().min(1).max(MAX_RESPONSE_BYTES),
  maxTimeoutMs: z.int().min(1).max(MAX_TIMEOUT_MS),
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
}

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
    });
    if (!entry.pathPrefixes.includes(route.upstreamPath))
      entry.pathPrefixes.push(route.upstreamPath);
    if (!entry.methods.includes(route.method)) entry.methods.push(route.method);
  }
  const routes = Object.values(config.routes);
  return {
    v: 1,
    upstreams,
    maxBodyBytes: Math.max(0, ...routes.map((route) => route.maxBodyBytes)),
    maxResponseBytes: 1024 * 1024,
    maxTimeoutMs: Math.max(
      1,
      ...Object.values(config.upstreams).map((upstream) => upstream.timeoutMs),
    ),
  };
}
