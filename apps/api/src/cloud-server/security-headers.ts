import type { HelmetOptions } from 'helmet';

/**
 * The headers of every answer of the Cloud server — the API's and the dashboard's files (T-84):
 *
 * - CSP: own files only, no inline script and no `unsafe-eval` (the dashboard's build has no
 *   inline script, `web:build:cloud`); `style-src 'unsafe-inline'` only because Angular and the
 *   spartan components set style attributes; `frame-ancestors 'none'` against clickjacking.
 * - HSTS only when the cookie is Secure, i.e. when the origin is HTTPS (on plain HTTP on localhost
 *   it would pin the browser to a scheme the server does not speak).
 * - `nosniff`, `Referrer-Policy: no-referrer`, a closed `Permissions-Policy`, same-origin
 *   opener/resource policies, no `X-Powered-By`.
 */
export function contentSecurityPolicy(secure: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** What the helmet middleware is configured with (bootstrap-cloud.ts). */
export function cloudHelmetOptions(secure: boolean): HelmetOptions {
  const directives: Record<string, string[]> = {};
  for (const part of contentSecurityPolicy(secure).split('; ')) {
    const [name = '', ...values] = part.split(' ');
    directives[name] = values;
  }
  return {
    contentSecurityPolicy: { useDefaults: false, directives },
    strictTransportSecurity: secure
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  };
}

/** Helmet has no Permissions-Policy; the features Moat never needs are closed. */
export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';
