import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../encoding/base64url';
import { readBundleTimes } from './bundle-times';

const envelope = (payload: unknown): string =>
  JSON.stringify({
    moat: 'bundle',
    v: 1,
    payload: toBase64Url(new TextEncoder().encode(JSON.stringify(payload))),
    sigs: [],
  });

describe('readBundleTimes', () => {
  it('reads version, issue time and expiry', () => {
    expect(
      readBundleTimes(
        envelope({ version: 3, issuedAt: 1000, expiresAt: 2000 }),
      ),
    ).toEqual({ version: 3, issuedAt: 1000, expiresAt: 2000 });
    expect(
      readBundleTimes(envelope({ version: 1, issuedAt: 0, expiresAt: null })),
    ).toEqual({ version: 1, issuedAt: 0, expiresAt: null });
  });

  it('answers null for anything that is not a bundle envelope', () => {
    const bad = [
      '',
      'nope',
      'null',
      '[]',
      JSON.stringify({ payload: 5 }),
      JSON.stringify({ payload: '***' }),
      envelope('text'),
      envelope({ version: 0, issuedAt: 1, expiresAt: null }),
      envelope({ version: 1.5, issuedAt: 1, expiresAt: null }),
      envelope({ version: 1, issuedAt: -1, expiresAt: null }),
      envelope({ version: 1, issuedAt: '1', expiresAt: null }),
      envelope({ version: 1, issuedAt: 1 }),
      envelope({ version: 1, issuedAt: 1, expiresAt: 'soon' }),
      'x'.repeat(1024 * 1024 + 1),
    ];
    for (const text of bad)
      expect(readBundleTimes(text), text.slice(0, 30)).toBeNull();
  });
});
