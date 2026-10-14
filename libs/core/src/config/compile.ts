import { reject } from '../errors';
import type { JsonValue } from '../json/strict-json';
import { validateCompiledConfig, type CompiledConfig } from './compiled';
import { gateLockState } from './lock';
import type { MoatConfig } from './schema';
import { parseDuration, parseSize } from './units';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_CONTENT_TYPES = ['application/json'];

/**
 * moat.yaml → the compiled config a bundle carries: defaults filled in, units turned into
 * integers, then validated exactly as a gate will (step 9 of docs/CRYPTO.md §4.3) against the
 * names of the secrets that go into the bundle. Throws `config_invalid`.
 *
 * With `gate`, the config is compiled for that gate: when the gate or its environment is locked,
 * it carries `enabled: false` and the gate refuses every request.
 */
export function compileConfig(
  config: MoatConfig,
  secretNames: readonly string[],
  gate?: string,
): CompiledConfig {
  const upstreams: Record<string, JsonValue> = {};
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    upstreams[name] = {
      origin: upstream.origin,
      auth: upstream.auth ?? null,
      timeoutMs:
        upstream.timeout === undefined
          ? DEFAULT_TIMEOUT_MS
          : (parseDuration(upstream.timeout) ?? reject('config_invalid')),
    };
  }
  const routes: Record<string, JsonValue> = {};
  for (const [name, route] of Object.entries(config.routes)) {
    routes[name] = {
      method: route.method,
      path: route.path,
      upstream: route.upstream,
      upstreamPath: route.upstreamPath,
      maxBodyBytes:
        route.maxBodySize === undefined
          ? DEFAULT_MAX_BODY_BYTES
          : (parseSize(route.maxBodySize) ?? reject('config_invalid')),
      contentTypes: route.contentTypes ?? DEFAULT_CONTENT_TYPES,
      responseContentTypes: route.responseContentTypes ?? DEFAULT_CONTENT_TYPES,
      enabled: route.enabled ?? true,
      origins: route.origins ?? [],
      rateLimit:
        route.rateLimit === undefined
          ? null
          : {
              requests: route.rateLimit.requests,
              windowSeconds:
                (parseDuration(route.rateLimit.window) ??
                  reject('config_invalid')) / 1000,
              per: route.rateLimit.per ?? 'ip',
            },
      ...(route.quota === undefined
        ? {}
        : {
            quota: {
              requests: route.quota.requests,
              period: route.quota.period,
            },
          }),
      ...(route.budget === undefined
        ? {}
        : { budget: JSON.parse(JSON.stringify(route.budget)) as JsonValue }),
      ...(route.body === undefined
        ? {}
        : { body: JSON.parse(JSON.stringify(route.body)) as JsonValue }),
    };
  }
  const locked = gate !== undefined && !gateLockState(config, gate).enabled;
  return validateCompiledConfig(
    {
      version: 1,
      ...(locked ? { enabled: false } : {}),
      upstreams,
      routes,
    },
    secretNames,
  );
}
