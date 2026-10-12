import type { CompiledRoute } from '../config/compiled';
import { reject } from '../errors';

/**
 * FR-15: origin binding and CORS for a matched route, the same in every gate
 * (conformance/vectors/http/cors.json). Origin binding stops browsers only — a script without a
 * browser sends any `Origin` or none (T-01, SEC-58). Credentials are never allowed: the gate uses
 * no cookies.
 */

/** Seconds a browser may cache a preflight answer. */
export const PREFLIGHT_MAX_AGE = 600;
/** The only request header a cross-origin caller may send besides the CORS-safelisted ones. */
const ALLOWED_REQUEST_HEADERS = ['content-type'];
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The `Access-Control-Allow-Origin` value for a request to `route`, or null for none. Throws
 * `origin_forbidden` when the route lists origins and the request carries another one. A request
 * without `Origin` passes (same-origin GET, or not a browser) — unless the browser says in
 * `Sec-Fetch-Site` that another site made it (`<img src>`, a link): those carry no `Origin`.
 */
export function checkOrigin(
  route: Pick<CompiledRoute, 'origins'>,
  origin: string | null,
  fetchSite: string | null = null,
): string | null {
  if (route.origins.length === 0) return null;
  if (origin === null) {
    if (fetchSite === 'cross-site' || fetchSite === 'same-site')
      reject('origin_forbidden');
    return null;
  }
  if (!route.origins.includes(origin)) reject('origin_forbidden');
  return origin;
}

export interface PreflightAnswer {
  allowOrigin: string;
  allowMethods: string[];
  allowHeaders: string[];
  maxAge: number;
}

/**
 * The answer to `OPTIONS` with `Origin` and `Access-Control-Request-Method` on a path whose
 * `routes` are given (at least one). Throws `preflight_rejected` unless a route at the path lists
 * the origin and has the requested method, and every requested header is allowed.
 */
export function preflight(
  routes: readonly Pick<CompiledRoute, 'method' | 'origins'>[],
  origin: string,
  requestMethod: string,
  requestHeaders: string | null,
): PreflightAnswer {
  const open = routes.filter((route) => route.origins.includes(origin));
  if (!open.some((route) => route.method === requestMethod))
    reject('preflight_rejected');
  for (const name of headerList(requestHeaders)) {
    if (!ALLOWED_REQUEST_HEADERS.includes(name)) reject('preflight_rejected');
  }
  return {
    allowOrigin: origin,
    allowMethods: [...new Set(open.map((route) => route.method))].sort(),
    allowHeaders: ['Content-Type'],
    maxAge: PREFLIGHT_MAX_AGE,
  };
}

/** `Access-Control-Request-Headers`: comma-separated tokens, lower-cased; empty items skipped. */
function headerList(value: string | null): string[] {
  if (value === null) return [];
  const names: string[] = [];
  for (const item of value.split(',')) {
    const name = item.replace(/^[ \t]+|[ \t]+$/g, '');
    if (name === '') continue;
    if (!TOKEN.test(name)) reject('preflight_rejected');
    names.push(name.toLowerCase());
  }
  return names;
}
