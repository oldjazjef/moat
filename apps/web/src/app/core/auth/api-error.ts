import { HttpErrorResponse } from '@angular/common/http';

/**
 * The closed list of answers the Cloud API gives (`{ statusCode, error }`, SEC-34): every one has
 * a translated text under `errors.api.<code>`. Nothing else is ever shown — a code that is not
 * listed (or a body that is no `{ error }` at all) becomes `unknown`, so a server text, a stack
 * or a value can never reach the page.
 */
export const API_ERROR_CODES = [
  'invalid_credentials',
  'mfa_required',
  'email_not_verified',
  'invalid_token',
  'invalid_code',
  'rate_limited',
  'already_enabled',
  'not_pending',
  'not_enabled',
  'no_passkey',
  'passkey_unavailable',
  'passkey_limit',
  'passkey_exists',
  'passkey_invalid',
  'challenge_invalid',
  'email_invalid',
  'password_too_short',
  'password_too_long',
  'password_unchanged',
  'name_invalid',
  'last_owner',
  'release_not_applicable',
  'forbidden',
  'unauthenticated',
  'csrf_invalid',
  'origin_invalid',
  'empty_change',
  'config_changed',
  'config_invalid',
  'config_too_large',
  'config_missing',
  'changed',
  'fingerprint_mismatch',
  'gate_id_invalid',
  'box_key_invalid',
  'signer_key_invalid',
  'managed_unavailable',
  'gate_exists',
  'gate_limit',
  'secret_invalid',
  'version_stale',
  'secret_limit',
  'not_managed',
  'not_signed',
  'bundle_invalid',
  'secrets_missing',
  'gate_unknown',
  'not_found',
  'network',
  'unknown',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** The code of a failed request, never the server's own words. */
export function apiErrorCode(error: unknown): ApiErrorCode {
  if (!(error instanceof HttpErrorResponse)) return 'unknown';
  if (error.status === 0) return 'network';
  const body: unknown = error.error;
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const code = (body as { error: unknown }).error;
    if (typeof code === 'string' && KNOWN.has(code)) {
      return code as ApiErrorCode;
    }
  }
  // A foreign tenant's resource and a missing one both answer a bare 404 (SEC-50).
  return error.status === 404 ? 'not_found' : 'unknown';
}

/** The i18n key of an error's text. */
export function apiErrorKey(code: ApiErrorCode): string {
  return `errors.api.${code}`;
}

/** The second factors an `mfa_required` answer names (after the password was right). */
export function apiErrorMethods(error: unknown): ('totp' | 'passkey')[] {
  if (!(error instanceof HttpErrorResponse)) return [];
  const body: unknown = error.error;
  if (typeof body !== 'object' || body === null || !('methods' in body))
    return [];
  const methods = (body as { methods: unknown }).methods;
  if (!Array.isArray(methods)) return [];
  return methods.filter(
    (m): m is 'totp' | 'passkey' => m === 'totp' || m === 'passkey',
  );
}
