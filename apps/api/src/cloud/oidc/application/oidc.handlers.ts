import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import { IdTokenError, pkceChallenge, verifyIdToken } from '@moat/core';
import { Clock, iso, newId } from '../../common/clock';
import {
  PASSWORD_INPUT_MAX_BYTES,
  normaliseEmail,
  SSO_PASSWORD_MARKER,
  hasPassword,
} from '../../auth/domain/credentials';
import { SESSION_TOKEN, sessionIdOf } from '../../auth/domain/session';
import {
  AccountRepositoryPort,
  SessionRepositoryPort,
} from '../../auth/ports/auth.ports';
import { PasswordHasher } from '../../auth/application/password-hasher';
import {
  OIDC_PER_IP,
  RateLimiter,
  REAUTH_FAILURES_PER_ACCOUNT,
} from '../../auth/application/rate-limiter';
import { SessionIssuer } from '../../auth/application/session-issuer';
import { InvitationRedeemer } from '../../tenancy/application/invitation-redeemer';
import type { OidcProvider } from '../domain/providers';
import { OidcRepositoryPort } from '../ports/oidc.ports';
import { OidcClient } from './oidc-client';
import {
  FinishOidcCommand,
  type FinishOidcResult,
  ListOidcProvidersQuery,
  type OidcFailure,
  type OidcProviderView,
  StartOidcLinkCommand,
  type StartOidcLinkResult,
  StartOidcLoginCommand,
  type StartOidcResult,
} from './oidc.commands';

/** The configured providers and where the provider sends the browser back to. */
export class OidcProviders {
  constructor(
    readonly list: readonly OidcProvider[],
    readonly redirectUri: string,
  ) {}

  find(id: string): OidcProvider | undefined {
    return this.list.find((provider) => provider.id === id);
  }
}

/** A sign-in in progress lives this long. */
export const OIDC_LOGIN_TTL_MS = 10 * 60 * 1000;

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const random = (): string => randomBytes(32).toString('base64url');
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

@QueryHandler(ListOidcProvidersQuery)
export class ListOidcProvidersHandler implements IQueryHandler<ListOidcProvidersQuery> {
  constructor(private readonly providers: OidcProviders) {}

  execute(): Promise<readonly OidcProviderView[]> {
    return Promise.resolve(
      this.providers.list.map(({ id, name }) => ({ id, name })),
    );
  }
}

/** What both ways of starting share: state, nonce, PKCE and the stored login in progress. */
abstract class Starter {
  constructor(
    protected readonly providers: OidcProviders,
    protected readonly client: OidcClient,
    protected readonly oidc: OidcRepositoryPort,
    protected readonly limiter: RateLimiter,
    protected readonly clock: Clock,
  ) {}

  protected async begin(
    provider: OidcProvider,
    purpose: 'login' | 'link',
    accountId: string | null,
  ): Promise<StartOidcResult> {
    const state = random();
    const nonce = random();
    const verifier = random();
    const browserSecret = random();
    const now = this.clock.now();
    let url: string;
    try {
      url = await this.client.authorizeUrl(provider, {
        redirectUri: this.providers.redirectUri,
        state,
        nonce,
        challenge: await pkceChallenge(verifier),
      });
    } catch {
      return { status: 'unavailable' };
    }
    await this.oidc.issueLogin({
      id: sha256Hex(state),
      provider: provider.id,
      purpose,
      accountId,
      nonce,
      verifier,
      browserHash: sha256Hex(browserSecret),
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + OIDC_LOGIN_TTL_MS)),
    });
    return { status: 'ok', url, browserSecret };
  }

  protected async limited(ip: string): Promise<StartOidcResult | null> {
    const wait = await this.limiter.retryAfter(OIDC_PER_IP, ip);
    if (wait !== null)
      return { status: 'rate_limited', retryAfterSeconds: wait };
    await this.limiter.record(OIDC_PER_IP, ip);
    return null;
  }
}

@CommandHandler(StartOidcLoginCommand)
export class StartOidcLoginHandler
  extends Starter
  implements ICommandHandler<StartOidcLoginCommand>
{
  constructor(
    providers: OidcProviders,
    client: OidcClient,
    oidc: OidcRepositoryPort,
    limiter: RateLimiter,
    clock: Clock,
  ) {
    super(providers, client, oidc, limiter, clock);
  }

  async execute(command: StartOidcLoginCommand): Promise<StartOidcResult> {
    const provider = this.providers.find(command.provider);
    if (provider === undefined) return { status: 'not_found' };
    const limited = await this.limited(command.ip);
    if (limited !== null) return limited;
    return this.begin(provider, 'login', null);
  }
}

@CommandHandler(StartOidcLinkCommand)
export class StartOidcLinkHandler
  extends Starter
  implements ICommandHandler<StartOidcLinkCommand>
{
  constructor(
    providers: OidcProviders,
    client: OidcClient,
    oidc: OidcRepositoryPort,
    limiter: RateLimiter,
    clock: Clock,
    private readonly accounts: AccountRepositoryPort,
    private readonly hasher: PasswordHasher,
  ) {
    super(providers, client, oidc, limiter, clock);
  }

  async execute(command: StartOidcLinkCommand): Promise<StartOidcLinkResult> {
    const provider = this.providers.find(command.provider);
    if (provider === undefined) return { status: 'not_found' };
    const limited = await this.limited(command.ip);
    if (limited !== null) return limited;
    const wait = await this.limiter.retryAfter(
      REAUTH_FAILURES_PER_ACCOUNT,
      command.accountId,
    );
    if (wait !== null)
      return { status: 'rate_limited', retryAfterSeconds: wait };
    const account = await this.accounts.findById(command.accountId);
    if (
      account === null ||
      !hasPassword(account.passwordHash) ||
      Buffer.byteLength(command.password, 'utf8') > PASSWORD_INPUT_MAX_BYTES ||
      !(await this.hasher.verify(account.passwordHash, command.password))
    ) {
      await this.limiter.record(REAUTH_FAILURES_PER_ACCOUNT, command.accountId);
      return { status: 'refused', code: 'invalid_credentials' };
    }
    return this.begin(provider, 'link', account.id);
  }
}

@CommandHandler(FinishOidcCommand)
export class FinishOidcHandler implements ICommandHandler<FinishOidcCommand> {
  constructor(
    private readonly providers: OidcProviders,
    private readonly client: OidcClient,
    private readonly oidc: OidcRepositoryPort,
    private readonly accounts: AccountRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly issuer: SessionIssuer,
    private readonly redeemer: InvitationRedeemer,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  async execute(command: FinishOidcCommand): Promise<FinishOidcResult> {
    const failed = (
      code: OidcFailure,
      purpose: 'login' | 'link' = 'login',
    ): FinishOidcResult => ({ status: 'failed', code, purpose });
    const wait = await this.limiter.retryAfter(OIDC_PER_IP, command.ip);
    if (wait !== null) return failed('failed');
    await this.limiter.record(OIDC_PER_IP, command.ip);
    if (!BASE64URL_43.test(command.state) || command.code === '')
      return failed('failed');

    // The login in progress is used up first: whatever follows, this state works once.
    const login = await this.oidc.consumeLogin(
      sha256Hex(command.state),
      iso(this.clock.now()),
    );
    if (login === null) return failed('failed');
    const purpose = login.purpose;
    // Only the browser that started the sign-in may finish it (login CSRF, T-104).
    if (
      command.browserSecret === null ||
      !BASE64URL_43.test(command.browserSecret) ||
      !sameHash(sha256Hex(command.browserSecret), login.browserHash)
    )
      return failed('failed', purpose);
    const provider = this.providers.find(login.provider);
    if (provider === undefined) return failed('failed', purpose);

    let claims;
    try {
      const idToken = await this.client.exchange(provider, {
        code: command.code,
        verifier: login.verifier,
        redirectUri: this.providers.redirectUri,
      });
      const expectation = {
        issuer: provider.issuer,
        clientId: provider.clientId,
        nonce: login.nonce,
        now: Math.floor(this.clock.now().getTime() / 1000),
      };
      try {
        claims = await verifyIdToken(
          idToken,
          await this.client.keys(provider),
          expectation,
        );
      } catch (error) {
        // A key we do not know may be a rotated one: look once more.
        if (!(error instanceof IdTokenError) || error.code !== 'key')
          throw error;
        claims = await verifyIdToken(
          idToken,
          await this.client.keys(provider, true),
          expectation,
        );
      }
    } catch {
      return failed('failed', purpose);
    }

    const at = iso(this.clock.now());
    if (purpose === 'link') {
      if (login.accountId === null) return failed('failed', purpose);
      const known = await this.oidc.findIdentity(provider.id, claims.subject);
      if (known !== null)
        return known.accountId === login.accountId
          ? { status: 'linked' }
          : failed('identity_taken', purpose);
      const added = await this.oidc.addIdentity({
        id: newId(),
        accountId: login.accountId,
        provider: provider.id,
        subject: claims.subject,
        createdAt: at,
        lastLoginAt: null,
      });
      return added === 'ok'
        ? { status: 'linked' }
        : failed('identity_taken', purpose);
    }

    let accountId: string;
    const known = await this.oidc.findIdentity(provider.id, claims.subject);
    if (known !== null) {
      if ((await this.accounts.findById(known.accountId)) === null)
        return failed('failed');
      accountId = known.accountId;
      await this.oidc.touchIdentity(known.id, at);
    } else {
      // A new person: only with an address the provider says it verified, and never by taking
      // over an account that exists (that needs the password, on the account page).
      const email =
        claims.emailVerified && claims.email !== null
          ? normaliseEmail(claims.email)
          : null;
      if (email === null) return failed('email_unverified');
      accountId = newId();
      const created = await this.accounts.create({
        id: accountId,
        email,
        passwordHash: SSO_PASSWORD_MARKER,
        passwordChangedAt: at,
        createdAt: at,
        emailVerifiedAt: at,
      });
      if (created === 'email_taken') return failed('email_taken');
      const added = await this.oidc.addIdentity({
        id: newId(),
        accountId,
        provider: provider.id,
        subject: claims.subject,
        createdAt: at,
        lastLoginAt: at,
      });
      if (added === 'taken') return failed('failed');
      await this.redeemer.redeem(accountId, email);
    }
    // A session cookie that came with the request is ended, never adopted (fixation).
    if (
      command.previousToken !== null &&
      SESSION_TOKEN.test(command.previousToken)
    )
      await this.sessions.revoke(sessionIdOf(command.previousToken), at);
    return { status: 'signed_in', session: await this.issuer.issue(accountId) };
  }
}

export const OIDC_HANDLERS = [
  ListOidcProvidersHandler,
  StartOidcLoginHandler,
  StartOidcLinkHandler,
  FinishOidcHandler,
];
