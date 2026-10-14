/**
 * Where «Testen» sends its request: the gate's address as the person typed it (the URL of
 * `moat-gate.php`, or of the folder a rewrite serves it from) plus the route's path, as the
 * website calls it (gates/php/README.md, Requests). Only HTTPS; plain HTTP only to this computer
 * and only in development (`allowLoopbackHttp`), for a gate under `php -S`. No credentials, query
 * or fragment: nothing but the route's path is added. Which addresses the host may resolve to is
 * the client's check (address-rules.ts).
 */
export const MAX_GATE_URL = 2048;

export function gateTestTarget(
  gateUrl: string,
  routePath: string,
  allowLoopbackHttp: boolean,
): URL | null {
  if (gateUrl.length > MAX_GATE_URL || /[\s\\]/.test(gateUrl)) return null;
  let url: URL;
  try {
    url = new URL(gateUrl);
  } catch {
    return null;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && loopback && allowLoopbackHttp)
  )
    return null;
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return null;
  if (gateUrl.includes('?') || gateUrl.includes('#')) return null;
  if (!routePath.startsWith('/')) return null;
  const base = url.pathname.replace(/\/+$/, '');
  const target = new URL(url.origin);
  target.pathname = `${base}${routePath}`;
  return target;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
