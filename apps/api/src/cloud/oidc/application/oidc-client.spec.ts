import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../testing/in-memory';
import { OidcClient, OidcProviderError } from './oidc-client';
import { OidcHttp } from './oidc-http';

const PROVIDER = {
  id: 'idp',
  name: 'IdP',
  issuer: 'https://idp.example.com',
  clientId: 'cid',
  clientSecret: 'planted-secret',
};
const DOC = {
  issuer: PROVIDER.issuer,
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/jwks',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  id_token_signing_alg_values_supported: ['RS256'],
};

class FakeHttp extends OidcHttp {
  readonly gets: string[] = [];
  readonly posts: {
    url: string;
    form: Record<string, string>;
    auth: string;
  }[] = [];
  constructor(
    private doc: Record<string, unknown> = DOC,
    private keys: unknown = { keys: [{ kty: 'EC', kid: 'a' }] },
    private token: unknown = { id_token: 'a.b.c' },
  ) {
    super();
  }
  set(doc: Record<string, unknown>) {
    this.doc = doc;
  }
  getJson(url: string) {
    this.gets.push(url);
    return Promise.resolve(url.endsWith('/jwks') ? this.keys : this.doc);
  }
  postForm(url: string, form: Record<string, string>, auth: string) {
    this.posts.push({ url, form, auth });
    return Promise.resolve(this.token);
  }
}

const make = (http: OidcHttp, clock = new FixedClock()) => ({
  client: new OidcClient(http, clock, false),
  clock,
});

describe('OidcClient (SEC-51, T-105)', () => {
  it('reads and caches the discovery document for an hour', async () => {
    const http = new FakeHttp();
    const { client, clock } = make(http);
    await client.discovery(PROVIDER);
    await client.discovery(PROVIDER);
    expect(http.gets).toEqual([
      'https://idp.example.com/.well-known/openid-configuration',
    ]);
    clock.advance(61 * 60 * 1000);
    await client.discovery(PROVIDER);
    expect(http.gets).toHaveLength(2);
  });

  it('refuses a document of another issuer, with http endpoints, or without the code flow with S256', async () => {
    const wrong: Record<string, unknown>[] = [
      { ...DOC, issuer: 'https://evil.example' },
      { ...DOC, token_endpoint: 'http://idp.example.com/token' },
      { ...DOC, jwks_uri: 'https://10.0.0.1/jwks' },
      { ...DOC, authorization_endpoint: undefined },
      { ...DOC, response_types_supported: ['token'] },
      { ...DOC, code_challenge_methods_supported: ['plain'] },
      { ...DOC, id_token_signing_alg_values_supported: ['HS256'] },
    ];
    for (const doc of wrong) {
      const { client } = make(new FakeHttp(doc));
      await expect(
        client.discovery(PROVIDER),
        JSON.stringify(doc),
      ).rejects.toBeInstanceOf(OidcProviderError);
    }
  });

  it('builds the authorization URL with PKCE S256, a nonce and the fixed scope', async () => {
    const { client } = make(new FakeHttp());
    const url = new URL(
      await client.authorizeUrl(PROVIDER, {
        redirectUri: 'https://moat.example.ch/api/auth/oidc/callback',
        state: 's',
        nonce: 'n',
        challenge: 'c',
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://moat.example.ch/api/auth/oidc/callback',
      scope: 'openid email',
      state: 's',
      nonce: 'n',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code with the client credentials in the Authorization header only', async () => {
    const http = new FakeHttp();
    const { client } = make(http);
    expect(
      await client.exchange(PROVIDER, {
        code: 'the-code',
        verifier: 'v',
        redirectUri: 'https://moat.example.ch/cb',
      }),
    ).toBe('a.b.c');
    const call = http.posts[0];
    expect(call?.url).toBe(DOC.token_endpoint);
    expect(call?.form).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://moat.example.ch/cb',
      code_verifier: 'v',
    });
    expect(Buffer.from(call?.auth ?? '', 'base64').toString()).toBe(
      'cid:planted-secret',
    );
    expect(JSON.stringify(call?.form)).not.toContain('planted-secret');
  });

  it('refuses an answer without a usable id_token', async () => {
    for (const token of [
      {},
      { id_token: '' },
      { id_token: 5 },
      { id_token: 'x'.repeat(20000) },
      null,
    ]) {
      const { client } = make(new FakeHttp(DOC, undefined, token));
      await expect(
        client.exchange(PROVIDER, {
          code: 'c',
          verifier: 'v',
          redirectUri: 'https://x.example/cb',
        }),
      ).rejects.toBeInstanceOf(OidcProviderError);
    }
  });

  it('caches the key set, and looks again for an unknown key only every five minutes', async () => {
    const http = new FakeHttp();
    const { client, clock } = make(http);
    await client.keys(PROVIDER);
    await client.keys(PROVIDER);
    await client.keys(PROVIDER, true);
    const jwks = () => http.gets.filter((u) => u.endsWith('/jwks')).length;
    expect(jwks()).toBe(1);
    clock.advance(6 * 60 * 1000);
    await client.keys(PROVIDER, true);
    expect(jwks()).toBe(2);
  });

  it('refuses a key set that is not a bounded list', async () => {
    for (const keys of [
      {},
      { keys: 'x' },
      { keys: Array.from({ length: 51 }, () => ({})) },
    ]) {
      const { client } = make(new FakeHttp(DOC, keys));
      await expect(client.keys(PROVIDER)).rejects.toBeInstanceOf(
        OidcProviderError,
      );
    }
  });
});
