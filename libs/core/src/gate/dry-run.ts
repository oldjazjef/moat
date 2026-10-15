import {
  hostKey,
  type CompiledConfig,
  type CompiledRoute,
  type CompiledUpstream,
} from '../config/compiled';
import { toBase64 } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import { validateBody } from '../http/body';
import { requestEstimate, type Budget, type Usage } from '../http/budget';
import { mediaTypeOf } from '../http/content-type';
import { honeypotFilled } from '../http/client';
import { checkOrigin, preflight } from '../http/cors';
import { normalisePath } from '../http/path';
import { checkPolicy, type Policy } from '../policy/policy';
import type { KillSwitch } from './kill-switch';

/**
 * The test console (FR-42): what a gate would do with one request, worked out from the config
 * alone, before anything is signed — no gate, no network, no secret. It follows the gate's order
 * (gates/php RequestHandler; conformance/http/ checks both agree): lock and kill switch, path
 * normalised and matched exactly, CORS preflight, method, origin, body size and media type, the
 * body's fields (FR-13), the budget's bound, then the upstream call the gate would build. What only a running gate knows —
 * counters for rate limits, quotas and budgets, the upstream's answer — is named, not guessed.
 */

/** The error answers a dry run can predict, with the gate's status for each (GateError). */
export const DRY_RUN_ERRORS = {
  not_found: 404,
  method_not_allowed: 405,
  path_invalid: 400,
  body_invalid: 400,
  request_unbounded: 400,
  body_too_large: 413,
  unsupported_media_type: 415,
  origin_forbidden: 403,
  preflight_rejected: 403,
  route_disabled: 503,
  gate_disabled: 503,
  gate_not_configured: 503,
  secret_unavailable: 500,
  client_unauthorized: 401,
} as const;
export type DryRunError = keyof typeof DRY_RUN_ERRORS;

/** Stands for a secret's value wherever the gate would put it; the dry run never has one. */
export const SECRET_PLACEHOLDER = '<SECRET>';
/** Stands for the OAuth2 access token the gate fetches (FR-20); only the gate has one. */
export const ACCESS_TOKEN_PLACEHOLDER = '<TOKEN>';
/** The gate's own User-Agent on every upstream call. */
export const GATE_USER_AGENT = 'moat-gate';
/** The longest body the console sends to the API (it stays below the API's own request limit). */
export const MAX_DRY_RUN_BODY = 32 * 1024;

export interface DryRunRequest {
  readonly method: string;
  /** What follows the gate file in the URL (`/newsletter`), query included; '' for nothing. */
  readonly path: string;
  /** Header names in any case; only those a gate reads matter. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DryRunContext {
  readonly config: CompiledConfig;
  readonly policy: Policy;
  /** The names of the secrets sealed into the bundle. */
  readonly secrets: readonly string[];
  /** The gate's local kill switch, when known. */
  readonly killSwitch?: KillSwitch;
}

/** A counter the gate checks on this request; only the gate knows how far it is. */
export interface DryRunCounter {
  readonly kind: 'perIp' | 'total' | 'route' | 'quota' | 'routeQuota';
  readonly requests: number;
  /** Seconds for a window, or the calendar period of a quota. */
  readonly per: number | 'day' | 'month';
}

export interface DryRunBudget {
  readonly scope: 'host' | 'route';
  readonly budget: Budget;
}

export interface DryRunUpstreamCall {
  readonly method: string;
  /** The full URL; a secret sent in the query appears as SECRET_PLACEHOLDER. */
  readonly url: string;
  /** In the order the gate sends them; a secret appears as SECRET_PLACEHOLDER. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
  readonly timeoutMs: number;
  /** The secret the gate opens for this call, or null. */
  readonly secret: string | null;
  /**
   * FR-20, OAuth2: the token request the gate sends first when it has no valid access token
   * cached — whether it has one, only the gate knows. Absent for every other auth.
   */
  readonly tokenCall?: DryRunTokenCall;
  /** FR-16: the Turnstile check the gate makes before it calls the upstream. */
  readonly turnstileCall?: DryRunTokenCall;
}

/** The OAuth2 token request (RFC 6749 §4.4) with the secret as SECRET_PLACEHOLDER. */
export interface DryRunTokenCall {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

export type DryRunResult =
  /** The bundle would not be accepted at all: the gate keeps its last one. */
  | { readonly kind: 'not_accepted'; readonly code: string }
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly error: DryRunError;
      readonly route: string | null;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'preflight';
      readonly status: 204;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'forwarded';
      readonly route: string;
      readonly call: DryRunUpstreamCall;
      /** Added to the upstream's answer (CORS). */
      readonly headers: Readonly<Record<string, string>>;
      readonly counters: readonly DryRunCounter[];
      readonly budgets: readonly DryRunBudget[];
      /** What the budgets are charged up front; null without a budget. */
      readonly estimate: Usage | null;
    };

const PREFLIGHT_VARY =
  'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';
const WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

class Refusal {
  constructor(
    readonly error: DryRunError,
    readonly headers: Record<string, string> = {},
    readonly route: string | null = null,
  ) {}
}

export function dryRun(
  context: DryRunContext,
  request: DryRunRequest,
): DryRunResult {
  try {
    checkPolicy(context.config, context.policy);
  } catch (error) {
    if (error instanceof MoatRejection)
      return { kind: 'not_accepted', code: error.code };
    throw error;
  }
  try {
    return run(context, request);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      kind: 'refused',
      status: DRY_RUN_ERRORS[error.error],
      error: error.error,
      route: error.route,
      headers: error.headers,
    };
  }
}

function run(context: DryRunContext, request: DryRunRequest): DryRunResult {
  const { config, policy } = context;
  const kill = context.killSwitch ?? { gate: false, routes: [] };
  const header = headerReader(request.headers);
  if (config.enabled === false || kill.gate) throw new Refusal('gate_disabled');
  const routes = routesAt(config, request.path);
  const origin = header('origin');
  const requestMethod = header('access-control-request-method');
  if (
    request.method === 'OPTIONS' &&
    origin !== null &&
    requestMethod !== null
  ) {
    let answer;
    try {
      answer = preflight(
        routes.map(([, route]) => route),
        origin,
        requestMethod,
        header('access-control-request-headers'),
      );
    } catch {
      throw new Refusal('preflight_rejected', { Vary: PREFLIGHT_VARY });
    }
    return {
      kind: 'preflight',
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': answer.allowOrigin,
        'Access-Control-Allow-Methods': answer.allowMethods.join(', '),
        'Access-Control-Allow-Headers': answer.allowHeaders.join(', '),
        'Access-Control-Max-Age': String(answer.maxAge),
        Vary: PREFLIGHT_VARY,
      },
    };
  }
  const [name, route] = match(routes, request.method, kill);
  let allowOrigin: string | null;
  try {
    allowOrigin = checkOrigin(route, origin, header('sec-fetch-site'));
  } catch {
    throw new Refusal('origin_forbidden', { Vary: 'Origin' }, name);
  }
  const cors: Record<string, string> = {};
  if (allowOrigin !== null) {
    cors['Access-Control-Allow-Origin'] = allowOrigin;
    cors['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  if (route.origins.length > 0) cors['Vary'] = 'Origin';
  const refuse = (error: DryRunError): never => {
    throw new Refusal(error, cors, name);
  };
  // FR-16: the API key and the JWT come before the limits. Only the gate can open the key's
  // secret and check a signature: the dry run sees only whether they are there.
  const client = route.client;
  if (
    client?.apiKey !== undefined &&
    !header(client.apiKey.header.toLowerCase())
  )
    refuse('client_unauthorized');
  if (
    client?.jwt !== undefined &&
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      header('authorization') ?? '',
    )
  )
    refuse('client_unauthorized');

  // Body size and media type (FR-18), with the bytes the gate would read.
  const bytes = new TextEncoder().encode(request.body).length;
  const maxBody = Math.min(route.maxBodyBytes, policy.maxBodyBytes);
  const declared = header('content-length');
  if (
    (declared !== null &&
      /^[0-9]{1,15}$/.test(declared) &&
      Number(declared) > maxBody) ||
    bytes > maxBody
  )
    refuse('body_too_large');
  const hasBody = request.body !== '' || WITH_BODY.has(route.method);
  const contentType = header('content-type');
  const mediaType = contentType === null ? null : mediaTypeOf(contentType);
  if (
    hasBody &&
    (mediaType === null || !route.contentTypes.includes(mediaType))
  )
    refuse('unsupported_media_type');
  // FR-13: only the listed fields go on, as canonical JSON — the budget estimates that body.
  let body = hasBody ? request.body : '';
  if (route.body !== undefined) {
    try {
      body = validateBody(route.body, new TextEncoder().encode(request.body));
    } catch (error) {
      if (error instanceof MoatRejection) refuse('body_invalid');
      throw error;
    }
  }

  // FR-16: a filled honeypot, then a missing Turnstile token (whose check only the gate makes).
  if (
    client?.honeypot !== undefined &&
    honeypotFilled(client.honeypot.field, request.body)
  )
    refuse('client_unauthorized');
  if (
    client?.turnstile !== undefined &&
    !header(client.turnstile.header.toLowerCase())
  )
    refuse('client_unauthorized');

  const upstream = config.upstreams[route.upstream];
  if (upstream === undefined) return refuse('gate_not_configured');
  const budgets: DryRunBudget[] = [];
  const hostBudget = policy.upstreams[hostKey(upstream.origin)]?.budget;
  if (hostBudget !== undefined)
    budgets.push({ scope: 'host', budget: hostBudget });
  if (route.budget !== undefined)
    budgets.push({ scope: 'route', budget: route.budget });
  let estimate: Usage | null = null;
  const [first] = budgets;
  if (first !== undefined) {
    const maxOutput = Math.min(
      ...budgets.map((entry) => entry.budget.maxOutputTokens),
    );
    estimate = requestEstimate(first.budget.usage, body, maxOutput);
    if (estimate === null) refuse('request_unbounded');
  }

  // cURL sends its User-Agent (CURLOPT_USERAGENT) before the headers the gate sets.
  const headers: [string, string][] = [
    ['User-Agent', GATE_USER_AGENT],
    ['Accept', route.responseContentTypes.join(', ')],
  ];
  if (hasBody && mediaType !== null) headers.push(['Content-Type', mediaType]);
  let url = upstream.origin + route.upstreamPath;
  let tokenCall: DryRunTokenCall | undefined;
  const auth = upstream.auth;
  if (auth !== null) {
    if (!context.secrets.includes(auth.secret)) refuse('secret_unavailable');
    if (auth.type === 'bearer')
      headers.push(['Authorization', `Bearer ${SECRET_PLACEHOLDER}`]);
    else if (auth.type === 'header')
      headers.push([auth.name, SECRET_PLACEHOLDER]);
    else if (auth.type === 'query')
      url += `?${encodeURIComponent(auth.param)}=${SECRET_PLACEHOLDER}`;
    else if (auth.type === 'basic')
      headers.push([
        'Authorization',
        `Basic ${basic(auth.username, SECRET_PLACEHOLDER)}`,
      ]);
    else {
      headers.push(['Authorization', `Bearer ${ACCESS_TOKEN_PLACEHOLDER}`]);
      tokenCall = tokenRequest(auth);
    }
  }
  return {
    kind: 'forwarded',
    route: name,
    call: {
      method: route.method,
      url,
      headers,
      body,
      timeoutMs: Math.min(upstream.timeoutMs, policy.maxTimeoutMs),
      secret: auth?.secret ?? null,
      ...(tokenCall === undefined ? {} : { tokenCall }),
      ...(client?.turnstile === undefined
        ? {}
        : {
            turnstileCall: {
              method: 'POST',
              url: client.turnstile.verifyUrl,
              headers: [
                ['User-Agent', GATE_USER_AGENT],
                ['Accept', 'application/json'],
                ['Content-Type', 'application/x-www-form-urlencoded'],
              ],
              body: `secret=${SECRET_PLACEHOLDER}&response=${formEncode(header(client.turnstile.header.toLowerCase()) ?? '')}`,
            },
          }),
    },
    headers: cors,
    counters: countersOf(policy, route),
    budgets,
    estimate,
  };
}

/** Like PHP's rawurlencode: every byte but `[A-Za-z0-9_.~-]` as `%XX`. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `base64(user ":" password)` of HTTP Basic (RFC 7617). */
function basic(user: string, password: string): string {
  return toBase64(utf8(`${user}:${password}`));
}

/**
 * The token request as the gate sends it (FR-20): client_secret_basic with the form-encoded
 * client id and secret (RFC 6749 §2.3.1), the grant and the scope as a form.
 */
function tokenRequest(
  auth: Extract<CompiledUpstream['auth'], { type: 'oauth2' }>,
): DryRunTokenCall {
  return {
    method: 'POST',
    url: auth.tokenUrl,
    headers: [
      ['User-Agent', GATE_USER_AGENT],
      ['Accept', 'application/json'],
      ['Content-Type', 'application/x-www-form-urlencoded'],
      [
        'Authorization',
        `Basic ${basic(formEncode(auth.clientId), SECRET_PLACEHOLDER)}`,
      ],
    ],
    body:
      'grant_type=client_credentials' +
      (auth.scope === undefined ? '' : `&scope=${formEncode(auth.scope)}`),
  };
}

/** The routes at the normalised path (exact match, SEC-42); `not_found` without one. */
function routesAt(
  config: CompiledConfig,
  rawPath: string,
): [string, CompiledRoute][] {
  const path = rawPath.split('?', 1)[0] ?? '';
  if (!path.startsWith('/')) throw new Refusal('not_found');
  let normalised: string;
  try {
    normalised = normalisePath(path);
  } catch {
    throw new Refusal('path_invalid');
  }
  const routes = Object.entries(config.routes).filter(
    ([, route]) => route.path === normalised,
  );
  if (routes.length === 0) throw new Refusal('not_found');
  return routes;
}

/** The route for the method; 405 with `Allow` when only the method differs. */
function match(
  routes: [string, CompiledRoute][],
  method: string,
  kill: KillSwitch,
): [string, CompiledRoute] {
  const found = routes.find(([, route]) => route.method === method);
  if (found === undefined) {
    const allow = routes.map(([, route]) => route.method).sort();
    throw new Refusal('method_not_allowed', { Allow: allow.join(', ') });
  }
  const [name, route] = found;
  if (!route.enabled || kill.routes.includes(name))
    throw new Refusal('route_disabled', {}, name);
  return found;
}

function countersOf(policy: Policy, route: CompiledRoute): DryRunCounter[] {
  const { limits } = policy;
  const counters: DryRunCounter[] = [
    {
      kind: 'perIp',
      requests: limits.perIp.requests,
      per: limits.perIp.windowSeconds,
    },
    {
      kind: 'total',
      requests: limits.total.requests,
      per: limits.total.windowSeconds,
    },
  ];
  if (route.rateLimit !== null)
    counters.push({
      kind: 'route',
      requests: route.rateLimit.requests,
      per: route.rateLimit.windowSeconds,
    });
  if (limits.quota !== undefined)
    counters.push({
      kind: 'quota',
      requests: limits.quota.requests,
      per: limits.quota.period,
    });
  if (route.quota !== undefined)
    counters.push({
      kind: 'routeQuota',
      requests: route.quota.requests,
      per: route.quota.period,
    });
  return counters;
}

/** First value of a header, case-insensitive; null when absent. */
function headerReader(
  headers: Readonly<Record<string, string>>,
): (name: string) => string | null {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (!lower.has(key.toLowerCase())) lower.set(key.toLowerCase(), value);
  }
  return (name) => lower.get(name) ?? null;
}
