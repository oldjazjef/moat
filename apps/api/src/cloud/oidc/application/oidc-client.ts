import { Injectable } from '@nestjs/common';
import type { Jwk } from '@moat/core';
import { Clock } from '../../common/clock';
import { isAllowedUrl, type OidcProvider } from '../domain/providers';
import { OidcHttp } from './oidc-http';

export class OidcProviderError extends Error {}

export interface Discovery {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

const CACHE_MS = 60 * 60 * 1000;
/** A key set is fetched again for an unknown key id at most this often. */
const REFETCH_MS = 5 * 60 * 1000;

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048;

/**
 * Talks to one configured provider at a time: discovery, the key set and the code exchange. What
 * it fetches is checked (the issuer in the document is the configured one, the endpoints are
 * https, the provider supports the authorization-code flow with S256 and a signature algorithm
 * Moat accepts) and cached for an hour.
 */
@Injectable()
export class OidcClient {
  private readonly discoveries = new Map<
    string,
    { at: number; value: Discovery }
  >();
  private readonly keySets = new Map<
    string,
    { at: number; keys: readonly Jwk[] }
  >();

  constructor(
    private readonly http: OidcHttp,
    private readonly clock: Clock,
    private readonly allowLoopbackHttp: boolean,
  ) {}

  async discovery(provider: OidcProvider): Promise<Discovery> {
    const now = this.clock.now().getTime();
    const cached = this.discoveries.get(provider.id);
    if (cached !== undefined && now - cached.at < CACHE_MS) return cached.value;
    const document = (await this.http.getJson(
      `${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    )) as Record<string, unknown> | null;
    if (typeof document !== 'object' || document === null)
      throw new OidcProviderError('discovery');
    if (document['issuer'] !== provider.issuer)
      throw new OidcProviderError('issuer');
    const authorization = document['authorization_endpoint'];
    const token = document['token_endpoint'];
    const jwks = document['jwks_uri'];
    for (const url of [authorization, token, jwks])
      if (!isText(url) || !isAllowedUrl(url, this.allowLoopbackHttp))
        throw new OidcProviderError('endpoint');
    const listed = (name: string, wanted: readonly string[]): boolean => {
      const value = document[name];
      return (
        value === undefined ||
        (Array.isArray(value) && wanted.some((w) => value.includes(w)))
      );
    };
    if (
      !listed('response_types_supported', ['code']) ||
      !listed('code_challenge_methods_supported', ['S256']) ||
      !listed('id_token_signing_alg_values_supported', ['RS256', 'ES256'])
    )
      throw new OidcProviderError('unsupported');
    const value: Discovery = {
      authorizationEndpoint: authorization as string,
      tokenEndpoint: token as string,
      jwksUri: jwks as string,
    };
    this.discoveries.set(provider.id, { at: now, value });
    return value;
  }

  /** The URL the browser is sent to (RFC 6749 §4.1.1 with PKCE S256 and a nonce). */
  async authorizeUrl(
    provider: OidcProvider,
    request: {
      redirectUri: string;
      state: string;
      nonce: string;
      challenge: string;
    },
  ): Promise<string> {
    const { authorizationEndpoint } = await this.discovery(provider);
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** The `id_token` the provider returns for a code (the access token is never used). */
  async exchange(
    provider: OidcProvider,
    request: { code: string; verifier: string; redirectUri: string },
  ): Promise<string> {
    const { tokenEndpoint } = await this.discovery(provider);
    // RFC 6749 §2.3.1: the client id and secret are form-encoded, then Basic-encoded.
    const basic = Buffer.from(
      `${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`,
      'utf8',
    ).toString('base64');
    const answer = (await this.http.postForm(
      tokenEndpoint,
      {
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.verifier,
      },
      basic,
    )) as Record<string, unknown> | null;
    const idToken = answer?.['id_token'];
    if (typeof idToken !== 'string' || idToken === '' || idToken.length > 16384)
      throw new OidcProviderError('token');
    return idToken;
  }

  /** The provider's signing keys; `refresh` asks again (a key id we do not know) but not too often. */
  async keys(provider: OidcProvider, refresh = false): Promise<readonly Jwk[]> {
    const now = this.clock.now().getTime();
    const cached = this.keySets.get(provider.id);
    if (
      cached !== undefined &&
      now - cached.at < (refresh ? REFETCH_MS : CACHE_MS)
    )
      return cached.keys;
    const { jwksUri } = await this.discovery(provider);
    const document = (await this.http.getJson(jwksUri)) as {
      keys?: unknown;
    } | null;
    const keys = document?.keys;
    if (!Array.isArray(keys) || keys.length > 50)
      throw new OidcProviderError('keys');
    const list = keys.filter(
      (key): key is Jwk => typeof key === 'object' && key !== null,
    );
    this.keySets.set(provider.id, { at: now, keys: list });
    return list;
  }
}
