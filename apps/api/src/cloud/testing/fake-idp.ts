import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * TEST ONLY: an OpenID Connect provider on this machine — discovery, a key set, and a token
 * endpoint that checks the client's Basic credentials and the PKCE verifier. Specs call
 * `issueCode` for what a person's consent would have produced.
 */
export interface IdpClaims {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly [key: string]: unknown;
}

const b64 = (data: string | Buffer) => Buffer.from(data).toString('base64url');

export class FakeIdp {
  readonly clientId = 'moat-test-client';
  readonly clientSecret = 'planted-client-secret-never-shown';
  private server!: Server;
  private readonly key: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private readonly codes = new Map<
    string,
    {
      claims: IdpClaims;
      nonce: string;
      challenge: string;
      overrides: Record<string, unknown>;
    }
  >();
  /** What the token endpoint was asked, for the specs to look at. */
  readonly tokenRequests: { body: URLSearchParams; authorization: string }[] =
    [];
  breakJwks = false;
  issuer = '';

  constructor(readonly kid = 'idp-key-1') {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.key = pair.privateKey;
    this.jwk = {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid,
      use: 'sig',
      alg: 'ES256',
    };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration')
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['ES256'],
        });
      if (url.pathname === '/jwks')
        return this.breakJwks ? json(500, {}) : json(200, { keys: [this.jwk] });
      if (url.pathname === '/token' && req.method === 'POST') {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => (raw += chunk));
        req.on('end', () => {
          const body = new URLSearchParams(raw);
          const authorization = String(req.headers['authorization'] ?? '');
          this.tokenRequests.push({ body, authorization });
          const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
          const entry = this.codes.get(body.get('code') ?? '');
          this.codes.delete(body.get('code') ?? '');
          const challenge = b64(
            createHash('sha256')
              .update(body.get('code_verifier') ?? '')
              .digest(),
          );
          if (
            authorization !== expected ||
            entry === undefined ||
            entry.challenge !== challenge ||
            body.get('grant_type') !== 'authorization_code'
          )
            return json(400, { error: 'invalid_grant' });
          return json(200, {
            access_token: 'unused',
            token_type: 'Bearer',
            id_token: this.idToken(entry.claims, entry.nonce, entry.overrides),
          });
        });
        return;
      }
      json(404, {});
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The `OIDC_PROVIDERS` entry for this provider. */
  provider(id = 'fakeidp', name = 'Fake IdP') {
    return {
      id,
      name,
      issuer: this.issuer,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    };
  }

  /** A code the person's consent would have produced for the request in `location`. */
  issueCode(
    location: string,
    claims: IdpClaims,
    overrides: Record<string, unknown> = {},
  ): { code: string; state: string } {
    const url = new URL(location);
    const code = randomBytes(16).toString('base64url');
    this.codes.set(code, {
      claims,
      nonce: url.searchParams.get('nonce') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
      overrides,
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  private idToken(
    claims: IdpClaims,
    nonce: string,
    overrides: Record<string, unknown>,
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const head = b64(
      JSON.stringify({ alg: 'ES256', kid: this.kid, typ: 'JWT' }),
    );
    const body = b64(
      JSON.stringify({
        iss: this.issuer,
        aud: this.clientId,
        iat: now,
        exp: now + 300,
        nonce,
        ...claims,
        ...overrides,
      }),
    );
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${head}.${body}.${b64(signature)}`;
  }
}
