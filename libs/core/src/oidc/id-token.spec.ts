import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../encoding/base64url';
import {
  IdTokenError,
  type IdTokenExpectation,
  type Jwk,
  pkceChallenge,
  verifyIdToken,
} from './id-token';

const ISSUER = 'https://idp.example.ch';
const CLIENT = 'moat-client';
const NOW = 1_800_000_000;
const EXPECT: IdTokenExpectation = {
  issuer: ISSUER,
  clientId: CLIENT,
  nonce: 'n-0S6_WzA2Mj',
  now: NOW,
};
const text = (value: unknown) =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

const good = () => ({
  iss: ISSUER,
  aud: CLIENT,
  sub: 'user-1',
  exp: NOW + 600,
  iat: NOW - 5,
  nonce: EXPECT.nonce,
  email: 'eme@example.ch',
  email_verified: true,
});

interface Signer {
  jwk: Jwk;
  sign(header: Record<string, unknown>, claims: unknown): Promise<string>;
}

async function ecSigner(kid = 'ec1'): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk;
  return {
    jwk: { ...jwk, kid, use: 'sig' },
    async sign(header, claims) {
      const head = text({ alg: 'ES256', kid, ...header });
      const body = text(claims);
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new TextEncoder().encode(`${head}.${body}`),
        ),
      );
      return `${head}.${body}.${toBase64Url(sig)}`;
    },
  };
}

async function rsaSigner(bits = 2048, kid = 'rsa1'): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: bits,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk;
  return {
    jwk: { ...jwk, kid },
    async sign(header, claims) {
      const head = text({ alg: 'RS256', kid, ...header });
      const body = text(claims);
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          pair.privateKey,
          new TextEncoder().encode(`${head}.${body}`),
        ),
      );
      return `${head}.${body}.${toBase64Url(sig)}`;
    },
  };
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IdTokenError) return error.code;
    throw error;
  }
  return 'accepted';
};

describe('verifyIdToken (SEC-51, T-104)', () => {
  it('accepts a good ES256 and a good RS256 token and returns only the claims Moat uses', async () => {
    const ec = await ecSigner();
    expect(
      await verifyIdToken(await ec.sign({}, good()), [ec.jwk], EXPECT),
    ).toEqual({
      subject: 'user-1',
      email: 'eme@example.ch',
      emailVerified: true,
    });
    const rsa = await rsaSigner();
    expect(
      (await verifyIdToken(await rsa.sign({}, good()), [rsa.jwk], EXPECT))
        .subject,
    ).toBe('user-1');
  });

  it('treats anything but a true e-mail_verified as "not verified"', async () => {
    const ec = await ecSigner();
    for (const value of [false, 'yes', 1, undefined, null]) {
      const token = await ec.sign({}, { ...good(), email_verified: value });
      expect((await verifyIdToken(token, [ec.jwk], EXPECT)).emailVerified).toBe(
        false,
      );
    }
    const token = await ec.sign({}, { ...good(), email_verified: 'true' });
    expect((await verifyIdToken(token, [ec.jwk], EXPECT)).emailVerified).toBe(
      true,
    );
  });

  it('refuses every wrong claim with its own code', async () => {
    const ec = await ecSigner();
    const attempt = async (
      claims: Record<string, unknown>,
      expectation = EXPECT,
    ) =>
      codeOf(
        ec
          .sign({}, claims)
          .then((token) => verifyIdToken(token, [ec.jwk], expectation)),
      );
    expect(await attempt({ ...good(), iss: 'https://evil.example' })).toBe(
      'issuer',
    );
    expect(await attempt({ ...good(), aud: 'someone-else' })).toBe('audience');
    expect(await attempt({ ...good(), aud: [CLIENT, 'other'] })).toBe(
      'audience',
    );
    expect(
      await attempt({ ...good(), aud: [CLIENT, 'other'], azp: CLIENT }),
    ).toBe('accepted');
    expect(await attempt({ ...good(), exp: NOW - 120 })).toBe('expired');
    expect(await attempt({ ...good(), exp: undefined })).toBe('expired');
    expect(await attempt({ ...good(), iat: NOW + 600 })).toBe('expired');
    expect(await attempt({ ...good(), nonce: 'other' })).toBe('nonce');
    expect(await attempt({ ...good(), nonce: undefined })).toBe('nonce');
    expect(await attempt({ ...good(), sub: '' })).toBe('claims');
    expect(await attempt({ ...good(), sub: 5 })).toBe('claims');
    // A little clock skew is fine.
    expect(await attempt({ ...good(), exp: NOW - 30 })).toBe('accepted');
  });

  it('refuses none, HS256, other curves, small RSA keys, unknown keys and tampering', async () => {
    const ec = await ecSigner();
    const other = await ecSigner('ec1');
    const token = await ec.sign({}, good());
    expect(await codeOf(verifyIdToken(token, [other.jwk], EXPECT))).toBe(
      'signature',
    );
    expect(await codeOf(verifyIdToken(token, [], EXPECT))).toBe('key');
    expect(
      await codeOf(verifyIdToken(token, [{ ...ec.jwk, kid: 'x' }], EXPECT)),
    ).toBe('key');
    expect(
      await codeOf(verifyIdToken(token, [{ ...ec.jwk, use: 'enc' }], EXPECT)),
    ).toBe('key');
    expect(
      await codeOf(verifyIdToken(token, [{ ...ec.jwk, crv: 'P-384' }], EXPECT)),
    ).toBe('key');
    for (const alg of ['none', 'HS256', 'PS256', 'EdDSA'])
      expect(
        await codeOf(
          verifyIdToken(
            `${text({ alg })}.${text(good())}.${toBase64Url(new Uint8Array(64))}`,
            [ec.jwk],
            EXPECT,
          ),
        ),
      ).toBe('algorithm');
    const [head, body, sig] = token.split('.') as [string, string, string];
    const forged = text({ ...good(), sub: 'admin' });
    expect(
      await codeOf(verifyIdToken(`${head}.${forged}.${sig}`, [ec.jwk], EXPECT)),
    ).toBe('signature');
    expect(
      await codeOf(verifyIdToken(`${head}.${body}.`, [ec.jwk], EXPECT)),
    ).toBe('malformed');
    expect(await codeOf(verifyIdToken('a.b', [ec.jwk], EXPECT))).toBe(
      'malformed',
    );
    expect(
      await codeOf(verifyIdToken('x'.repeat(17000), [ec.jwk], EXPECT)),
    ).toBe('malformed');
    expect(await codeOf(verifyIdToken('***.***.***', [ec.jwk], EXPECT))).toBe(
      'malformed',
    );
    const weak = await rsaSigner(1024);
    expect(
      await codeOf(
        verifyIdToken(await weak.sign({}, good()), [weak.jwk], EXPECT),
      ),
    ).toBe('signature');
    // An RSA key cannot be used for an ES256 token and the other way round.
    const rsa = await rsaSigner();
    expect(await codeOf(verifyIdToken(token, [rsa.jwk], EXPECT))).toBe('key');
  });

  it('wants a kid when several keys fit, and takes the only key when there is no kid', async () => {
    const a = await ecSigner('a');
    const b = await ecSigner('b');
    const noKid = await a.sign({ kid: undefined }, good());
    expect(await codeOf(verifyIdToken(noKid, [a.jwk, b.jwk], EXPECT))).toBe(
      'key',
    );
    expect(await codeOf(verifyIdToken(noKid, [a.jwk], EXPECT))).toBe(
      'accepted',
    );
    const viaB = await b.sign({}, good());
    expect(await codeOf(verifyIdToken(viaB, [a.jwk, b.jwk], EXPECT))).toBe(
      'accepted',
    );
  });
});

describe('pkceChallenge', () => {
  it('matches the RFC 7636 example', async () => {
    expect(
      await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
