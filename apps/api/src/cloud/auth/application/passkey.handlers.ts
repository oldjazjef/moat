import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import { toBase64Url } from '@moat/core';
import { Clock, iso, newId } from '../../common/clock';
import { PASSWORD_INPUT_MAX_BYTES } from '../domain/credentials';
import { passkeyName } from '../domain/passkey';
import {
  AccountRepositoryPort,
  MAX_PASSKEYS,
  type PasskeyRecord,
  PasskeyRepositoryPort,
  SessionRepositoryPort,
} from '../ports/auth.ports';
import {
  BeginPasskeyCommand,
  type BeginPasskeyResult,
  FinishPasskeyCommand,
  type FinishPasskeyResult,
  ListPasskeysQuery,
  PasskeyLoginChallengeCommand,
  type PasskeyLoginChallengeResult,
  type PasskeyView,
  type RateLimited,
  RemovePasskeyCommand,
  type RemovePasskeyResult,
} from './auth.commands';
import { LoginGate } from './login-gate';
import { PasskeyService } from './passkey-service';
import { PasswordHasher } from './password-hasher';
import { RateLimiter, REAUTH_FAILURES_PER_ACCOUNT } from './rate-limiter';
import { CHALLENGE_TTL_MS } from '../domain/passkey';

/** The name the browser shows next to the passkey. */
export const PASSKEY_RP_NAME = 'Moat';

const limited = (retryAfterSeconds: number): RateLimited => ({
  status: 'refused',
  code: 'rate_limited',
  retryAfterSeconds,
});

const viewOf = (p: PasskeyRecord): PasskeyView => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
});

const tooLarge = (password: string): boolean =>
  Buffer.byteLength(password, 'utf8') > PASSWORD_INPUT_MAX_BYTES;

@CommandHandler(PasskeyLoginChallengeCommand)
export class PasskeyLoginChallengeHandler implements ICommandHandler<PasskeyLoginChallengeCommand> {
  constructor(
    private readonly gate: LoginGate,
    private readonly passkeys: PasskeyRepositoryPort,
    private readonly service: PasskeyService,
  ) {}

  async execute(
    command: PasskeyLoginChallengeCommand,
  ): Promise<PasskeyLoginChallengeResult> {
    const checked = await this.gate.check(
      command.email,
      command.password,
      command.ip,
    );
    if (checked.status !== 'ok') return checked;
    // The password was right: now it may be said whether a passkey is there to use.
    const credentials = await this.passkeys.list(checked.account.id);
    if (credentials.length === 0)
      return { status: 'refused', code: 'no_passkey' };
    if (!this.service.available)
      return { status: 'refused', code: 'passkey_unavailable' };
    return {
      status: 'ok',
      challenge: await this.service.issueChallenge(checked.account.id, 'login'),
      rpId: this.service.rp.rpId,
      credentialIds: credentials.map((c) => c.credentialId),
      timeoutMs: CHALLENGE_TTL_MS,
    };
  }
}

/** Asks for the password again before anything about a passkey changes (the same limit as TOTP). */
abstract class Reauth {
  constructor(
    protected readonly accounts: AccountRepositoryPort,
    protected readonly hasher: PasswordHasher,
    protected readonly limiter: RateLimiter,
  ) {}

  /** The account when the password is right; a rate limit or null otherwise. */
  protected async reauth(
    accountId: string,
    password: string,
  ): Promise<
    | { readonly status: 'ok'; readonly email: string }
    | RateLimited
    | { readonly status: 'refused'; readonly code: 'invalid_credentials' }
  > {
    const wait = await this.limiter.retryAfter(
      REAUTH_FAILURES_PER_ACCOUNT,
      accountId,
    );
    if (wait !== null) return limited(wait);
    const account = await this.accounts.findById(accountId);
    if (
      account === null ||
      tooLarge(password) ||
      !(await this.hasher.verify(account.passwordHash, password))
    ) {
      await this.limiter.record(REAUTH_FAILURES_PER_ACCOUNT, accountId);
      return { status: 'refused', code: 'invalid_credentials' };
    }
    return { status: 'ok', email: account.email };
  }
}

@CommandHandler(BeginPasskeyCommand)
export class BeginPasskeyHandler
  extends Reauth
  implements ICommandHandler<BeginPasskeyCommand>
{
  constructor(
    accounts: AccountRepositoryPort,
    hasher: PasswordHasher,
    limiter: RateLimiter,
    private readonly passkeys: PasskeyRepositoryPort,
    private readonly service: PasskeyService,
  ) {
    super(accounts, hasher, limiter);
  }

  async execute(command: BeginPasskeyCommand): Promise<BeginPasskeyResult> {
    const checked = await this.reauth(command.accountId, command.password);
    if (checked.status !== 'ok') return checked;
    if (!this.service.available)
      return { status: 'refused', code: 'passkey_unavailable' };
    const existing = await this.passkeys.list(command.accountId);
    if (existing.length >= MAX_PASSKEYS)
      return { status: 'refused', code: 'passkey_limit' };
    return {
      status: 'ok',
      challenge: await this.service.issueChallenge(
        command.accountId,
        'register',
      ),
      rp: { id: this.service.rp.rpId, name: PASSKEY_RP_NAME },
      user: {
        id: toBase64Url(new TextEncoder().encode(command.accountId)),
        name: checked.email,
        displayName: checked.email,
      },
      excludeCredentials: existing.map((p) => p.credentialId),
      timeoutMs: CHALLENGE_TTL_MS,
    };
  }
}

@CommandHandler(FinishPasskeyCommand)
export class FinishPasskeyHandler implements ICommandHandler<FinishPasskeyCommand> {
  constructor(
    private readonly passkeys: PasskeyRepositoryPort,
    private readonly service: PasskeyService,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  async execute(command: FinishPasskeyCommand): Promise<FinishPasskeyResult> {
    const wait = await this.limiter.retryAfter(
      REAUTH_FAILURES_PER_ACCOUNT,
      command.accountId,
    );
    if (wait !== null) return limited(wait);
    if (!this.service.available)
      return { status: 'refused', code: 'passkey_unavailable' };
    const name = passkeyName(command.name);
    if (name === null) return { status: 'refused', code: 'name_invalid' };
    const made = await this.service.verifyRegistration(
      command.accountId,
      command.attestationObject,
      command.clientDataJSON,
    );
    if (typeof made === 'string') {
      await this.limiter.record(REAUTH_FAILURES_PER_ACCOUNT, command.accountId);
      return { status: 'refused', code: made };
    }
    const record: PasskeyRecord = {
      id: newId(),
      accountId: command.accountId,
      credentialId: made.credentialId,
      publicKey: made.publicKey,
      signCount: 0,
      name,
      createdAt: iso(this.clock.now()),
      lastUsedAt: null,
    };
    const outcome = await this.passkeys.add(record);
    if (outcome === 'limit')
      return { status: 'refused', code: 'passkey_limit' };
    if (outcome === 'credential_taken')
      return { status: 'refused', code: 'passkey_exists' };
    return { status: 'ok', passkey: viewOf(record) };
  }
}

@QueryHandler(ListPasskeysQuery)
export class ListPasskeysHandler implements IQueryHandler<ListPasskeysQuery> {
  constructor(private readonly passkeys: PasskeyRepositoryPort) {}

  async execute(query: ListPasskeysQuery): Promise<readonly PasskeyView[]> {
    return (await this.passkeys.list(query.accountId)).map(viewOf);
  }
}

@CommandHandler(RemovePasskeyCommand)
export class RemovePasskeyHandler
  extends Reauth
  implements ICommandHandler<RemovePasskeyCommand>
{
  constructor(
    accounts: AccountRepositoryPort,
    hasher: PasswordHasher,
    limiter: RateLimiter,
    private readonly passkeys: PasskeyRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly clock: Clock,
  ) {
    super(accounts, hasher, limiter);
  }

  async execute(command: RemovePasskeyCommand): Promise<RemovePasskeyResult> {
    const checked = await this.reauth(command.accountId, command.password);
    if (checked.status !== 'ok') return checked;
    if (!(await this.passkeys.remove(command.accountId, command.id)))
      return { status: 'refused', code: 'not_found' };
    // Other devices must sign in again; this one stays.
    await this.sessions.revokeAllOf(
      command.accountId,
      iso(this.clock.now()),
      command.sessionId,
    );
    return { status: 'ok' };
  }
}

export const PASSKEY_HANDLERS = [
  PasskeyLoginChallengeHandler,
  BeginPasskeyHandler,
  FinishPasskeyHandler,
  ListPasskeysHandler,
  RemovePasskeyHandler,
];
