import { Command, Query } from '@nestjs/cqrs';
import type { SessionGrant } from '../../auth/application/auth.commands';

export interface OidcProviderView {
  readonly id: string;
  readonly name: string;
}

export class ListOidcProvidersQuery extends Query<
  readonly OidcProviderView[]
> {}

export type StartOidcResult =
  | {
      readonly status: 'ok';
      /** Where to send the browser. */
      readonly url: string;
      /** The value of the secret cookie that binds the callback to this browser. */
      readonly browserSecret: string;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  /** The provider could not be reached or its document is unusable. */
  | { readonly status: 'unavailable' };

/** The browser asks to sign in with a provider. */
export class StartOidcLoginCommand extends Command<StartOidcResult> {
  constructor(
    readonly provider: string,
    readonly ip: string,
  ) {
    super();
  }
}

export type StartOidcLinkResult =
  | StartOidcResult
  | { readonly status: 'refused'; readonly code: 'invalid_credentials' };

/** A signed-in person links a provider to the account; the password is asked for again. */
export class StartOidcLinkCommand extends Command<StartOidcLinkResult> {
  constructor(
    readonly accountId: string,
    readonly password: string,
    readonly provider: string,
    readonly ip: string,
  ) {
    super();
  }
}

export type OidcFailure =
  'failed' | 'email_unverified' | 'email_taken' | 'identity_taken';

export type FinishOidcResult =
  | { readonly status: 'signed_in'; readonly session: SessionGrant }
  | { readonly status: 'linked' }
  | {
      readonly status: 'failed';
      readonly code: OidcFailure;
      /** Where the person was heading, to put the message on the right page. */
      readonly purpose: 'login' | 'link';
    };

/** The provider sent the browser back with a code. */
export class FinishOidcCommand extends Command<FinishOidcResult> {
  constructor(
    readonly state: string,
    readonly code: string,
    readonly browserSecret: string | null,
    readonly previousToken: string | null,
    readonly ip: string,
  ) {
    super();
  }
}
