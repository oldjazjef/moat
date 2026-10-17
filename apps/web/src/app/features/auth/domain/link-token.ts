/**
 * The token of a mailed link sits in the URL's fragment (`#token=…`), so it reaches no server log
 * and no Referer header. A token has exactly the shape the API issues (43 characters of base64url);
 * anything else is no token.
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function tokenFromFragment(fragment: string | null): string | null {
  if (fragment === null) return null;
  const value = new URLSearchParams(fragment).get('token');
  return value !== null && TOKEN.test(value) ? value : null;
}
