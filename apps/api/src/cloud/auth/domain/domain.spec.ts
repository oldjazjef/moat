import { describe, expect, it } from 'vitest';
import { normaliseEmail, PASSWORD_MAX, passwordProblem } from './credentials';
import {
  clearedSessionCookie,
  csrfMatches,
  csrfTokenOf,
  isSessionLive,
  newSessionToken,
  readCookie,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOKEN,
  sessionCookie,
  sessionIdOf,
} from './session';
import {
  base32Encode,
  hashRecoveryCode,
  hotp,
  newRecoveryCode,
  otpauthUri,
  parseRecoveryCode,
  parseTotpCode,
  TOTP_WINDOW,
  totpStep,
  verifyTotp,
} from './totp';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('passwords (min 12, max 256, no composition rules)', () => {
  it('counts characters, not bytes, and applies no other rule', () => {
    expect(passwordProblem('a'.repeat(11))).toBe('password_too_short');
    expect(passwordProblem('a'.repeat(12))).toBeNull();
    expect(passwordProblem('aaaaaaaaaaaa')).toBeNull();
    expect(passwordProblem('ä'.repeat(12))).toBeNull();
    expect(passwordProblem('a'.repeat(PASSWORD_MAX))).toBeNull();
    expect(passwordProblem('a'.repeat(PASSWORD_MAX + 1))).toBe(
      'password_too_long',
    );
    expect(passwordProblem('a'.repeat(5000))).toBe('password_too_long');
  });
});

describe('e-mail addresses', () => {
  it('trims, lower-cases and accepts ordinary ASCII addresses', () => {
    expect(normaliseEmail('  Eme@Example.CH ')).toBe('eme@example.ch');
    expect(normaliseEmail('a+b@sub.example.co.uk')).toBe(
      'a+b@sub.example.co.uk',
    );
  });
  it('refuses anything else', () => {
    for (const bad of [
      '',
      'no-at',
      'a@b',
      'a b@example.ch',
      'a@@example.ch',
      'ä@example.ch',
      'a@exämple.ch',
      'a@-example.ch',
      `${'x'.repeat(65)}@example.ch`,
      'a@example.ch\r\nBcc: x@y.z',
    ])
      expect(normaliseEmail(bad)).toBeNull();
  });
});

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 4226 and 6238 vectors', () => {
    // RFC 4226 Appendix D.
    expect(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(RFC_SECRET, c)),
    ).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]);
    // RFC 6238 Appendix B, SHA-1, 8 digits, T = 59 s.
    expect(hotp(RFC_SECRET, totpStep(59_000), 8)).toBe('94287082');
    expect(hotp(RFC_SECRET, totpStep(1111111109_000), 8)).toBe('07081804');
    expect(hotp(RFC_SECRET, totpStep(20000000000_000), 8)).toBe('65353130');
  });

  it('accepts the window, once, and nothing outside it', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const code = hotp(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, 0)).toBe(step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now + 30_000 * TOTP_WINDOW, 0)).toBe(
      step,
    );
    expect(
      verifyTotp(RFC_SECRET, code, now + 30_000 * (TOTP_WINDOW + 1), 0),
    ).toBeNull();
    expect(
      verifyTotp(RFC_SECRET, code, now - 30_000 * (TOTP_WINDOW + 1), 0),
    ).toBeNull();
    expect(verifyTotp(RFC_SECRET, '000000', now, 0)).toBeNull();
  });

  it('reads codes strictly', () => {
    expect(parseTotpCode('123 456')).toBe('123456');
    for (const bad of ['12345', '1234567', 'abcdef', '12345a', ''])
      expect(parseTotpCode(bad)).toBeNull();
  });

  it('encodes base32 and the key URI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('mzxw6ytboi');
    const uri = otpauthUri('Moat', 'a@example.ch', RFC_SECRET);
    expect(uri).toContain('otpauth://totp/Moat:a%40example.ch?');
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri).toContain('period=30');
  });

  it('makes recovery codes of 80 random bits that only parse back when well-formed', () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    expect(parseRecoveryCode(code.toUpperCase())).toBe(
      code.replaceAll('-', ''),
    );
    expect(parseRecoveryCode('123456')).toBeNull();
    expect(newRecoveryCode()).not.toBe(code);
    expect(hashRecoveryCode('aaaaaaaaaaaaaaaa')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sessions, CSRF tokens and cookies', () => {
  it('makes 256-bit tokens whose database id is their SHA-256', () => {
    const token = newSessionToken();
    expect(token).toMatch(SESSION_TOKEN);
    expect(newSessionToken()).not.toBe(token);
    expect(sessionIdOf(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionIdOf(token)).not.toContain(token);
  });

  it('is live until revoked, idle or past its absolute end', () => {
    const t0 = Date.parse('2026-10-15T12:00:00.000Z');
    const session = {
      lastSeenAt: new Date(t0).toISOString(),
      expiresAt: new Date(t0 + SESSION_ABSOLUTE_MS).toISOString(),
      revokedAt: null,
    };
    expect(isSessionLive(session, new Date(t0 + 1000))).toBe(true);
    expect(isSessionLive(session, new Date(t0 + SESSION_IDLE_MS))).toBe(false);
    expect(
      isSessionLive(
        {
          ...session,
          lastSeenAt: new Date(t0 + SESSION_ABSOLUTE_MS - 1000).toISOString(),
        },
        new Date(t0 + SESSION_ABSOLUTE_MS),
      ),
    ).toBe(false);
    expect(
      isSessionLive(
        { ...session, revokedAt: session.lastSeenAt },
        new Date(t0),
      ),
    ).toBe(false);
    expect(
      isSessionLive({ ...session, expiresAt: 'garbage' }, new Date(t0)),
    ).toBe(false);
  });

  it('binds the CSRF token to the session token', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(csrfMatches(a, csrfTokenOf(a))).toBe(true);
    expect(csrfMatches(a, csrfTokenOf(b))).toBe(false);
    expect(csrfMatches(a, undefined)).toBe(false);
    expect(csrfMatches(a, ['x'])).toBe(false);
    expect(csrfMatches(a, '')).toBe(false);
    expect(csrfTokenOf(a)).not.toContain(sessionIdOf(a));
  });

  it('sets HttpOnly, SameSite=Lax, Path=/ and Secure with the __Host- prefix', () => {
    const cookie = sessionCookie('tok', true, 100);
    expect(cookie).toBe(
      '__Host-moat_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=100; Secure',
    );
    expect(cookie).not.toMatch(/Domain/i);
  });

  it('drops Secure only when told to (localhost development)', () => {
    const cookie = sessionCookie('tok', false, 100);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    expect(cookie.startsWith('moat_session=')).toBe(true);
    expect(clearedSessionCookie(true)).toContain('Max-Age=0');
  });

  it('reads a cookie by name and refuses duplicates', () => {
    expect(readCookie('a=1; moat_session=xyz; b=2', 'moat_session')).toBe(
      'xyz',
    );
    expect(
      readCookie('moat_session=a; moat_session=b', 'moat_session'),
    ).toBeNull();
    expect(readCookie(undefined, 'moat_session')).toBeNull();
    expect(readCookie('x'.repeat(9000), 'moat_session')).toBeNull();
  });
});
