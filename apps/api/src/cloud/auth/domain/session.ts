import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Browser sessions (SEC-51, T-80). The cookie holds 256 random bits; the database holds only their
 * SHA-256, so a dump (or a log, or a backup) cannot be turned into a session. Pure.
 */

/** A session ends after this long without a request … */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** … and in any case this long after sign-in. */
export const SESSION_ABSOLUTE_MS = 14 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often (not on every request). */
export const SESSION_TOUCH_MS = 60 * 1000;

export const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The database key of a session: SHA-256 hex of the token. */
export function sessionIdOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionTimes {
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/** Revoked, past its absolute end, or idle for too long: not live. Fails closed on bad data. */
export function isSessionLive(session: SessionTimes, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  const expires = Date.parse(session.expiresAt);
  const lastSeen = Date.parse(session.lastSeenAt);
  if (Number.isNaN(expires) || Number.isNaN(lastSeen)) return false;
  return now.getTime() < expires && now.getTime() - lastSeen < SESSION_IDLE_MS;
}

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_ABSOLUTE_MS);
}

/**
 * The CSRF token of a session: HMAC-SHA-256 keyed with the session token. Bound to that session
 * (not a value any other page or subdomain could plant, as with a plain double-submit cookie),
 * and not derivable from what the database holds. The client gets it from the sign-in answer and
 * from `GET /api/auth/me` and sends it in `x-moat-csrf` (T-78).
 */
export function csrfTokenOf(sessionToken: string): string {
  return createHmac('sha256', sessionToken)
    .update('moat:csrf:v1', 'utf8')
    .digest('base64url');
}

export const CSRF_HEADER = 'x-moat-csrf';

export function csrfMatches(sessionToken: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const expected = Buffer.from(csrfTokenOf(sessionToken), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The session cookie: HttpOnly, SameSite=Lax, Path=/, no Domain; Secure unless `secure` is off
 * (http://localhost development only). With Secure it carries the `__Host-` prefix, so a browser
 * refuses a copy set by a sibling subdomain or over plain HTTP.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-moat_session' : 'moat_session';
}

export function sessionCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  return [
    `${sessionCookieName(secure)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${sessionCookieName(secure)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The value of cookie `name` in a Cookie header; the last of duplicates is not trusted (null). */
export function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string' || header.length > 8192) return null;
  let found: string | null = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    // Two cookies of that name: which one the browser meant is unknown, so none is used.
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
}
