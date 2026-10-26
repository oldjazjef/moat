/**
 * The cookie that ties the way back from the identity provider to the browser that left
 * (T-104): HttpOnly, SameSite=Lax (it must come along on the provider's top-level redirect),
 * Path=/, ten minutes. Like the session cookie it carries the `__Host-` prefix when Secure.
 */
export function oidcCookieName(secure: boolean): string {
  return secure ? '__Host-moat_oidc' : 'moat_oidc';
}

export function oidcCookie(value: string, secure: boolean): string {
  return [
    `${oidcCookieName(secure)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=600',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedOidcCookie(secure: boolean): string {
  return [
    `${oidcCookieName(secure)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
