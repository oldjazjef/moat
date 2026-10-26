import { describe, expect, it } from 'vitest';
import {
  isAllowedUrl,
  isPrivateHost,
  OidcConfigError,
  parseOidcProviders,
} from './providers';

const ok = {
  id: 'entra',
  name: 'Microsoft',
  issuer: 'https://login.example.com/tenant/v2.0',
  clientId: 'abc',
  clientSecret: 'planted-secret',
};
const parse = (value: unknown, loopback = false) =>
  parseOidcProviders(JSON.stringify(value), loopback);

describe('parseOidcProviders (SEC-51, T-104)', () => {
  it('reads a list and treats nothing as "no single sign-on"', () => {
    expect(parse([ok])).toEqual([ok]);
    expect(parseOidcProviders(undefined, false)).toEqual([]);
    expect(parseOidcProviders('  ', false)).toEqual([]);
  });

  it('refuses everything else without ever echoing a value', () => {
    const bad: unknown[] = [
      {},
      [{ ...ok, id: 'Entra' }],
      [{ ...ok, id: '1x' }],
      [{ ...ok, name: '' }],
      [{ ...ok, name: 'a\nb' }],
      [{ ...ok, issuer: 'http://login.example.com' }],
      [{ ...ok, issuer: 'https://login.example.com?x=1' }],
      [{ ...ok, issuer: 'https://u:p@login.example.com' }],
      [{ ...ok, issuer: 'https://10.0.0.1' }],
      [{ ...ok, issuer: 'https://localhost' }],
      [{ ...ok, issuer: 'ftp://x.example.com' }],
      [{ ...ok, clientId: '' }],
      [{ ...ok, clientSecret: '' }],
      [{ ...ok, extra: true }],
      [ok, { ...ok, name: 'Again' }],
      Array.from({ length: 6 }, (_, i) => ({ ...ok, id: `p${i}` })),
    ];
    for (const value of bad) {
      let message = '';
      try {
        parse(value);
      } catch (error) {
        expect(error).toBeInstanceOf(OidcConfigError);
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(value)).not.toBe('');
      expect(message).not.toContain('planted-secret');
    }
    expect(() => parseOidcProviders('not json', false)).toThrow(
      OidcConfigError,
    );
  });

  it('allows http on this machine only when asked to (development and tests)', () => {
    const local = { ...ok, issuer: 'http://127.0.0.1:9000' };
    expect(() => parse([local])).toThrow(OidcConfigError);
    expect(parse([local], true)).toHaveLength(1);
    expect(isAllowedUrl('http://example.com', true)).toBe(false);
  });
});

describe('isPrivateHost', () => {
  it('knows loopback, private, link-local and localhost names', () => {
    for (const host of [
      'localhost',
      'a.localhost',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      '[::1]',
      'fd00::1',
      'fe80::1',
    ])
      expect(isPrivateHost(host), host).toBe(true);
    for (const host of [
      'login.example.com',
      '8.8.8.8',
      '172.32.0.1',
      '2001:db8::1',
    ])
      expect(isPrivateHost(host), host).toBe(false);
  });
});
