/**
 * What an e-mail address and a password may look like (SEC-51, OWASP ASVS 2.1): the length is the
 * only rule for a password, no composition rules. Pure, so the specs and the handlers share it.
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
/** A hard stop before any hashing: a request must not make the server hash megabytes. */
export const PASSWORD_INPUT_MAX_BYTES = 1024;

export type PasswordProblem = 'password_too_short' | 'password_too_long';

/** NFKC so that the same password typed on another keyboard hashes the same (ASVS 2.1.8). */
export function normalisePassword(password: string): string {
  return password.normalize('NFKC');
}

/** Length is counted in characters (code points) of the normalised password. */
export function passwordProblem(password: string): PasswordProblem | null {
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_INPUT_MAX_BYTES)
    return 'password_too_long';
  const length = [...normalisePassword(password)].length;
  if (length < PASSWORD_MIN) return 'password_too_short';
  if (length > PASSWORD_MAX) return 'password_too_long';
  return null;
}

/**
 * The sign-in name: ASCII only (so that lower-casing is the same in the application and in the
 * database's CHECK), one `@`, a dotted domain. Not a full RFC 5322 parser on purpose; the address
 * is only verified by a mail that is sent to it, which is a later slice.
 */
const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The normalised address, or null when it is not one. */
export function normaliseEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return EMAIL.test(email) ? email : null;
}
