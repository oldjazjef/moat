import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * TOTP (RFC 6238) on HOTP (RFC 4226) with HMAC-SHA-1, 6 digits, 30-second steps: what every
 * authenticator app speaks. node:crypto only. Pure.
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
/** Steps either side of "now" that are accepted (clock drift). */
export const TOTP_WINDOW = 1;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower case, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4226 §5.3 dynamic truncation. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = TOTP_DIGITS,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[19] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** What a person types: exactly six digits (spaces are tolerated). */
export function parseTotpCode(input: string): string | null {
  const code = input.replace(/\s/g, '');
  return /^[0-9]{6}$/.test(code) ? code : null;
}

/**
 * The step `code` is valid for, or null. A step at or below `lastStep` is refused (a code is
 * accepted once, T-79). All steps of the window are compared whatever the outcome, and each
 * comparison is constant-time.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastStep: number,
): number | null {
  const given = Buffer.from(code, 'utf8');
  const current = totpStep(nowMs);
  let accepted: number | null = null;
  for (
    let step = current - TOTP_WINDOW;
    step <= current + TOTP_WINDOW;
    step++
  ) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    const equal =
      expected.length === given.length && timingSafeEqual(expected, given);
    if (equal && step > lastStep && (accepted === null || step > accepted))
      accepted = step;
  }
  return accepted;
}

/** The URI an authenticator app reads from the QR code (Key URI format). */
export function otpauthUri(
  issuer: string,
  email: string,
  secret: Uint8Array,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const query = new URLSearchParams({
    secret: base32Encode(secret).toUpperCase(),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Recovery codes: 80 random bits each, `xxxx-xxxx-xxxx-xxxx`; only their SHA-256 is stored. */
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCode(): string {
  const text = base32Encode(randomBytes(10));
  return text.match(/.{4}/g)?.join('-') ?? text;
}

/** The normalised code, or null when the input cannot be a recovery code. */
export function parseRecoveryCode(input: string): string | null {
  const code = input.toLowerCase().replace(/[\s-]/g, '');
  return /^[a-z2-7]{16}$/.test(code) ? code : null;
}

export function hashRecoveryCode(normalised: string): string {
  return createHash('sha256')
    .update('moat:recovery:v1\n', 'utf8')
    .update(normalised, 'utf8')
    .digest('hex');
}
