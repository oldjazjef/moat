import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  FinishOidcCommand,
  type FinishOidcResult,
  ListOidcProvidersQuery,
  type OidcProviderView,
  StartOidcLinkCommand,
  type StartOidcLinkResult,
  StartOidcLoginCommand,
  type StartOidcResult,
} from './application/oidc.commands';

/** The façade of the controller (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class OidcService {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  providers(): Promise<readonly OidcProviderView[]> {
    return this.queries.execute(new ListOidcProvidersQuery());
  }

  startLogin(provider: string, ip: string): Promise<StartOidcResult> {
    return this.commands.execute(new StartOidcLoginCommand(provider, ip));
  }

  startLink(
    accountId: string,
    password: string,
    provider: string,
    ip: string,
  ): Promise<StartOidcLinkResult> {
    return this.commands.execute(
      new StartOidcLinkCommand(accountId, password, provider, ip),
    );
  }

  finish(
    state: string,
    code: string,
    browserSecret: string | null,
    previousToken: string | null,
    ip: string,
  ): Promise<FinishOidcResult> {
    return this.commands.execute(
      new FinishOidcCommand(state, code, browserSecret, previousToken, ip),
    );
  }
}
