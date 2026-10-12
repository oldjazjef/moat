import { z } from 'zod';
import { MEDIA_TYPE } from '../http/content-type';
import {
  compiledRouteSchema,
  isWebOrigin,
  LIMIT_SCOPES,
  MAX_LIMIT_REQUESTS,
  MAX_ORIGINS,
  MAX_WINDOW_SECONDS,
  compiledUpstreamSchema,
  MAX_BODY_BYTES,
  MAX_TIMEOUT_MS,
  METHODS,
  NAME,
} from './compiled';
import { parseDuration, parseSize } from './units';

/**
 * moat.yaml, version 1 — the single source of the config format (CLAUDE.md, YAML standards).
 * `schema/moat.schema.json` is generated from it (`pnpm schema`). Keys are the bundle's keys;
 * only durations and sizes are written with units here and compiled to integers.
 */

const name = z.string().regex(NAME);
const duration = (max: number) =>
  z.string().refine((value) => {
    const ms = parseDuration(value);
    return ms !== null && ms <= max;
  }, `a duration such as "10s", at most ${max} ms`);
const size = (max: number) =>
  z.string().refine((value) => {
    const bytes = parseSize(value);
    return bytes !== null && bytes <= max;
  }, `a size such as "64KiB", at most ${max} bytes`);

export const upstreamSchema = z.strictObject({
  /** `https://host[:port]` of the API — HTTPS only, no path. */
  origin: compiledUpstreamSchema.shape.origin.describe(
    'HTTPS origin of the API, e.g. "https://api.hubapi.com"',
  ),
  /** How the gate authenticates to the API; `secret` names a sealed secret, never a value. */
  auth: compiledUpstreamSchema.shape.auth.optional(),
  timeout: duration(MAX_TIMEOUT_MS).optional().describe('e.g. "10s" (default)'),
});

export const routeSchema = z.strictObject({
  method: z.enum(METHODS),
  /** The path the website calls on the gate, e.g. "/newsletter" — matched exactly (SEC-42). */
  path: compiledRouteSchema.shape.path,
  upstream: name,
  /** The path on the upstream this route calls. */
  upstreamPath: compiledRouteSchema.shape.upstreamPath,
  maxBodySize: size(MAX_BODY_BYTES)
    .optional()
    .describe('e.g. "16KiB"; default "64KiB"'),
  contentTypes: z.array(z.string().regex(MEDIA_TYPE)).min(1).max(8).optional(),
  responseContentTypes: z
    .array(z.string().regex(MEDIA_TYPE))
    .min(1)
    .max(8)
    .optional(),
  enabled: z.boolean().optional(),
  /** Browser origins allowed to call this route from another site (FR-15), e.g. "https://www.example.ch". */
  origins: z
    .array(
      z
        .string()
        .refine(isWebOrigin, 'an origin such as "https://www.example.ch"'),
    )
    .max(MAX_ORIGINS)
    .optional(),
  /** FR-30, e.g. `{requests: 5, window: "1m"}`; per client IP unless `per: route`. */
  rateLimit: z
    .strictObject({
      requests: z.int().min(1).max(MAX_LIMIT_REQUESTS),
      window: z.string().refine((value) => {
        const ms = parseDuration(value);
        return (
          ms !== null && ms % 1000 === 0 && ms <= MAX_WINDOW_SECONDS * 1000
        );
      }, 'whole seconds such as "1m", at most "1d"'),
      per: z.enum(LIMIT_SCOPES).optional(),
    })
    .optional(),
});

export const moatConfigSchema = z
  .strictObject({
    version: z.literal(1),
    upstreams: z.record(name, upstreamSchema),
    routes: z.record(name, routeSchema),
  })
  .describe('Moat configuration (moat.yaml), version 1');

export type MoatConfig = z.infer<typeof moatConfigSchema>;

/** The JSON Schema committed as schema/moat.schema.json (editor completion, FR-40). */
export function moatJsonSchema(): object {
  return z.toJSONSchema(moatConfigSchema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });
}
