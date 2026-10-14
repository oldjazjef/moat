import { describe, expect, it } from 'vitest';
import { addressAllowed, addressKind } from './address-rules';

describe('address rules of «Testen» (T-59, as SEC-41)', () => {
  it('takes public addresses', () => {
    for (const address of ['8.8.8.8', '104.16.0.1', '2606:4700::1111'])
      expect(addressKind(address)).toBe('public');
  });

  it('refuses the network this computer sits in, and every special range', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      'not-an-address',
    ])
      expect(addressAllowed(address, true), address).toBe(false);
  });

  it('reaches loopback only in development', () => {
    for (const address of ['127.0.0.1', '127.8.8.8', '::1']) {
      expect(addressKind(address)).toBe('loopback');
      expect(addressAllowed(address, false)).toBe(false);
      expect(addressAllowed(address, true)).toBe(true);
    }
  });
});
